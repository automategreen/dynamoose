import CustomError = require("../Error");
import {Schema, SchemaDefinition, DynamoDBSetTypeResult, ValueType, IndexItem} from "../Schema";
import {Document as DocumentCarrier, DocumentSaveSettings, DocumentSettings, DocumentObjectFromSchemaSettings, AnyDocument} from "../Document";
import utils = require("../utils");
import ddb = require("../aws/ddb/internal");
import Internal = require("../Internal");
import {Serializer, SerializerOptions} from "../Serializer";
import {Condition, ConditionInitalizer} from "../Condition";
import {Scan, Query} from "../DocumentRetriever";
import {CallbackType, ObjectType, FunctionType, DocumentArray, ModelType, DeepPartial} from "../General";
import {custom as customDefaults, original as originalDefaults} from "./defaults";
import {ModelIndexChangeType} from "../utils/dynamoose/index_changes";
import {PopulateDocuments} from "../Populate";

import {DynamoDB, AWSError} from "aws-sdk";
import {GetTransactionInput, CreateTransactionInput, DeleteTransactionInput, UpdateTransactionInput, ConditionTransactionInput} from "../Transaction";

// Defaults
interface ModelWaitForActiveSettings {
	enabled: boolean;
	check: {timeout: number; frequency: number};
}
export interface ModelExpiresSettings {
	ttl: number;
	attribute: string;
	items?: {
		returnExpired: boolean;
	};
}
enum ModelUpdateOptions {
	ttl = "ttl",
	indexes = "indexes",
	throughput = "throughput"
}
export interface ModelOptions {
	create: boolean;
	throughput: "ON_DEMAND" | number | {read: number; write: number};
	prefix: string;
	suffix: string;
	waitForActive: boolean | ModelWaitForActiveSettings;
	update: boolean | ModelUpdateOptions[];
	populate: string | string[] | boolean;
	expires: number | ModelExpiresSettings;
}
export type ModelOptionsOptional = DeepPartial<ModelOptions>;


type KeyObject = {[attribute: string]: string | number};
type InputKey = string | KeyObject;

// Transactions
type GetTransactionResult = Promise<GetTransactionInput>;
type CreateTransactionResult = Promise<CreateTransactionInput>;
type DeleteTransactionResult = Promise<DeleteTransactionInput>;
type UpdateTransactionResult = Promise<UpdateTransactionInput>;
type ConditionTransactionResult = Promise<ConditionTransactionInput>;

export interface GetTransaction {
	(key: InputKey): GetTransactionResult;
	(key: InputKey, settings?: ModelGetSettings): GetTransactionResult;
	(key: InputKey, settings: ModelGetSettings & {return: "document"}): GetTransactionResult;
	(key: InputKey, settings: ModelGetSettings & {return: "request"}): GetTransactionResult;
}
export interface CreateTransaction {
	(document: ObjectType): CreateTransactionResult;
	(document: ObjectType, settings: DocumentSaveSettings & {return: "request"}): CreateTransactionResult;
	(document: ObjectType, settings: DocumentSaveSettings & {return: "document"}): CreateTransactionResult;
	(document: ObjectType, settings?: DocumentSaveSettings): CreateTransactionResult;
}
export interface DeleteTransaction {
	(key: InputKey): DeleteTransactionResult;
	(key: InputKey, settings: ModelDeleteSettings & {return: "request"}): DeleteTransactionResult;
	(key: InputKey, settings: ModelDeleteSettings & {return: null}): DeleteTransactionResult;
	(key: InputKey, settings?: ModelDeleteSettings): DeleteTransactionResult;
}
export interface UpdateTransaction {
	(obj: ObjectType): CreateTransactionResult;
	(keyObj: ObjectType, updateObj: ObjectType): UpdateTransactionResult;
	(keyObj: ObjectType, updateObj: ObjectType, settings: ModelUpdateSettings & {"return": "document"}): UpdateTransactionResult;
	(keyObj: ObjectType, updateObj: ObjectType, settings: ModelUpdateSettings & {"return": "request"}): UpdateTransactionResult;
	(keyObj: ObjectType, updateObj?: ObjectType, settings?: ModelUpdateSettings): UpdateTransactionResult;
}
export interface ConditionTransaction {
	(key: InputKey, condition: Condition): ConditionTransactionResult;
}

type TransactionType = {
	get: GetTransaction;
	create: CreateTransaction;
	delete: DeleteTransaction;
	update: UpdateTransaction;
	condition: ConditionTransaction;
};

// Utility functions
async function getTableDetails (model: Model<DocumentCarrier>, settings: {allowError?: boolean; forceRefresh?: boolean} = {}): Promise<DynamoDB.DescribeTableOutput> {
	const func = async (): Promise<void> => {
		const tableDetails: DynamoDB.DescribeTableOutput = await ddb("describeTable", {"TableName": model.name});
		model.latestTableDetails = tableDetails; // eslint-disable-line require-atomic-updates
	};
	if (settings.forceRefresh || !model.latestTableDetails) {
		if (settings.allowError) {
			try {
				await func();
			} catch (e) {} // eslint-disable-line no-empty
		} else {
			await func();
		}
	}

	return model.latestTableDetails;
}
async function createTableRequest (model: Model<DocumentCarrier>): Promise<DynamoDB.CreateTableInput> {
	return {
		"TableName": model.name,
		...utils.dynamoose.get_provisioned_throughput(model.options),
		...await model.getCreateTableAttributeParams()
	};
}
async function createTable (model: Model<DocumentCarrier>): Promise<void | (() => Promise<void>)> {
	if (((await getTableDetails(model, {"allowError": true}) || {}).Table || {}).TableStatus === "ACTIVE") {
		model.alreadyCreated = true;
		return (): Promise<void> => Promise.resolve.bind(Promise)();
	}

	await ddb("createTable", await createTableRequest(model));
}
async function updateTimeToLive (model: Model<DocumentCarrier>): Promise<void> {
	let ttlDetails;

	async function updateDetails (): Promise<void> {
		ttlDetails = await ddb("describeTimeToLive", {
			"TableName": model.name
		});
	}
	await updateDetails();

	function updateTTL (): Promise<DynamoDB.UpdateTimeToLiveOutput> {
		return ddb("updateTimeToLive", {
			"TableName": model.name,
			"TimeToLiveSpecification": {
				"AttributeName": (model.options.expires as ModelExpiresSettings).attribute,
				"Enabled": true
			}
		});
	}

	switch (ttlDetails.TimeToLiveDescription.TimeToLiveStatus) {
	case "DISABLING":
		while (ttlDetails.TimeToLiveDescription.TimeToLiveStatus === "DISABLING") {
			await utils.timeout(1000);
			await updateDetails();
		}
		// fallthrough
	case "DISABLED":
		await updateTTL();
		break;
	default:
		break;
	}
}
function waitForActive (model: Model<DocumentCarrier>, forceRefreshOnFirstAttempt = true) {
	return (): Promise<void> => new Promise((resolve, reject) => {
		const start = Date.now();
		async function check (count: number): Promise<void> {
			if (typeof model.options.waitForActive !== "boolean") {
				try {
					// Normally we'd want to do `dynamodb.waitFor` here, but since it doesn't work with tables that are being updated we can't use it in this case
					const tableDetails = (await getTableDetails(model, {"forceRefresh": forceRefreshOnFirstAttempt === true ? forceRefreshOnFirstAttempt : count > 0})).Table;
					if (tableDetails.TableStatus === "ACTIVE" && (tableDetails.GlobalSecondaryIndexes ?? []).every((val) => val.IndexStatus === "ACTIVE")) {
						return resolve();
					}
				} catch (e) {
					return reject(e);
				}

				if (count > 0) {
					model.options.waitForActive.check.frequency === 0 ? await utils.set_immediate_promise() : await utils.timeout(model.options.waitForActive.check.frequency);
				}
				if (Date.now() - start >= model.options.waitForActive.check.timeout) {
					return reject(new CustomError.WaitForActiveTimeout(`Wait for active timed out after ${Date.now() - start} milliseconds.`));
				} else {
					check(++count);
				}
			}
		}
		check(0);
	});
}
async function updateTable (model: Model<DocumentCarrier>): Promise<void> {
	const updateAll = typeof model.options.update === "boolean" && model.options.update;
	// Throughput
	if (updateAll || (model.options.update as ModelUpdateOptions[]).includes(ModelUpdateOptions.throughput)) {
		const currentThroughput = (await getTableDetails(model)).Table;
		const expectedThroughput: any = utils.dynamoose.get_provisioned_throughput(model.options);
		const isThroughputUpToDate = expectedThroughput.BillingMode === (currentThroughput.BillingModeSummary || {}).BillingMode && expectedThroughput.BillingMode || (currentThroughput.ProvisionedThroughput || {}).ReadCapacityUnits === (expectedThroughput.ProvisionedThroughput || {}).ReadCapacityUnits && currentThroughput.ProvisionedThroughput.WriteCapacityUnits === expectedThroughput.ProvisionedThroughput.WriteCapacityUnits;

		if (!isThroughputUpToDate) {
			const object: DynamoDB.UpdateTableInput = {
				"TableName": model.name,
				...expectedThroughput
			};
			await ddb("updateTable", object);
			await waitForActive(model)();
		}
	}
	// Indexes
	if (updateAll || (model.options.update as ModelUpdateOptions[]).includes(ModelUpdateOptions.indexes)) {
		const tableDetails = await getTableDetails(model);
		const existingIndexes = tableDetails.Table.GlobalSecondaryIndexes;
		const updateIndexes = await utils.dynamoose.index_changes(model, existingIndexes);
		await updateIndexes.reduce(async (existingFlow, index) => {
			await existingFlow;
			const params: DynamoDB.UpdateTableInput = {
				"TableName": model.name
			};
			if (index.type === ModelIndexChangeType.add) {
				params.AttributeDefinitions = (await model.getCreateTableAttributeParams()).AttributeDefinitions;
				params.GlobalSecondaryIndexUpdates = [{"Create": index.spec}];
			} else {
				params.GlobalSecondaryIndexUpdates = [{"Delete": {"IndexName": index.name}}];
			}
			await ddb("updateTable", params);
			await waitForActive(model)();
		}, Promise.resolve());
	}
}

interface ModelGetSettings {
	return?: "document" | "request";
	attributes?: string[];
	consistent?: boolean;
}
interface ModelDeleteSettings {
	return?: null | "request";
	condition?: Condition;
}
interface ModelBatchPutSettings {
	return?: "response" | "request";
}
interface ModelUpdateSettings {
	return?: "document" | "request";
	condition?: Condition;
	returnValues?: DynamoDB.ReturnValue;
}
interface ModelBatchGetDocumentsResponse<T> extends DocumentArray<T> {
	unprocessedKeys: ObjectType[];
}
interface ModelBatchGetSettings {
	return?: "documents" | "request";
	attributes?: string[];
}
interface ModelBatchDeleteSettings {
	return?: "response" | "request";
}
export interface ModelIndexes {
	GlobalSecondaryIndexes?: IndexItem[];
	LocalSecondaryIndexes?: IndexItem[];
}

// Model represents one DynamoDB table
export class Model<T extends DocumentCarrier = AnyDocument> {
	constructor (name: string, schema: Schema | SchemaDefinition | (Schema | SchemaDefinition)[], options: ModelOptionsOptional) {
		this.options = utils.combine_objects(options, customDefaults.get(), originalDefaults) as ModelOptions;
		this.name = `${this.options.prefix}${name}${this.options.suffix}`;
		this.originalName = name;

		let realSchemas: Schema[];
		if (!schema || Array.isArray(schema) && schema.length === 0) {
			throw new CustomError.MissingSchemaError(`Schema hasn't been registered for model "${name}".\nUse "dynamoose.model(name, schema)"`);
		} else if (!(schema instanceof Schema)) {
			if (Array.isArray(schema)) {
				realSchemas = schema.map((schema: Schema | SchemaDefinition): Schema => schema instanceof Schema ? schema : new Schema(schema));
			} else {
				realSchemas = [new Schema(schema)];
			}
		} else {
			realSchemas = [schema];
		}
		if (!utils.all_elements_match(realSchemas.map((schema) => schema.getHashKey()))) {
			throw new CustomError.InvalidParameter("hashKey's for all schema's must match.");
		}
		if (!utils.all_elements_match(realSchemas.map((schema) => schema.getRangeKey()).filter((key) => Boolean(key)))) {
			throw new CustomError.InvalidParameter("rangeKey's for all schema's must match.");
		}
		if (options.expires) {
			if (typeof options.expires === "number") {
				options.expires = {
					"attribute": "ttl",
					"ttl": options.expires
				};
			}
			options.expires = utils.combine_objects(options.expires as any, {"attribute": "ttl"});

			realSchemas.forEach((schema) => {
				schema.schemaObject[(options.expires as ModelExpiresSettings).attribute] = {
					"type": {
						"value": Date,
						"settings": {
							"storage": "seconds"
						}
					},
					"default": (): Date => new Date(Date.now() + (options.expires as ModelExpiresSettings).ttl)
				};
			});
		}
		this.schemas = realSchemas;

		// Setup flow
		this.ready = false; // Represents if model is ready to be used for actions such as "get", "put", etc. This property being true does not guarantee anything on the DynamoDB server. It only guarantees that Dynamoose has finished the initalization steps required to allow the model to function as expected on the client side.
		this.alreadyCreated = false; // Represents if the table in DynamoDB was created prior to initalization. This will only be updated if `create` is true.
		this.pendingTasks = []; // Represents an array of promise resolver functions to be called when Model.ready gets set to true (at the end of the setup flow)
		this.latestTableDetails = null; // Stores the latest result from `describeTable` for the given table
		this.pendingTaskPromise = (): Promise<void> => { // Returns a promise that will be resolved after the Model is ready. This is used in all Model operations (Model.get, Document.save) to `await` at the beginning before running the AWS SDK method to ensure the Model is setup before running actions on it.
			return this.ready ? Promise.resolve() : new Promise((resolve) => {
				this.pendingTasks.push(resolve);
			});
		};
		const setupFlow = []; // An array of setup actions to be run in order
		// Create table
		if (this.options.create) {
			setupFlow.push(() => createTable(this));
		}
		// Wait for Active
		if (this.options.waitForActive === true || (this.options.waitForActive || {}).enabled) {
			setupFlow.push(() => waitForActive(this, false));
		}
		// Update Time To Live
		if ((this.options.create || (Array.isArray(this.options.update) ? this.options.update.includes(ModelUpdateOptions.ttl) : this.options.update)) && options.expires) {
			setupFlow.push(() => updateTimeToLive(this));
		}
		// Update
		if (this.options.update && !this.alreadyCreated) {
			setupFlow.push(() => updateTable(this));
		}

		// Run setup flow
		const setupFlowPromise = setupFlow.reduce((existingFlow, flow) => {
			return existingFlow.then(() => flow()).then((flow) => {
				return typeof flow === "function" ? flow() : flow;
			});
		}, Promise.resolve());
		setupFlowPromise.then(() => this.ready = true).then(() => {
			this.pendingTasks.forEach((task) => task()); this.pendingTasks = [];
		});

		const self: Model<DocumentCarrier> = this;
		class Document extends DocumentCarrier {
			static Model: Model<DocumentCarrier>;
			constructor (object: DynamoDB.AttributeMap | ObjectType = {}, settings: DocumentSettings = {}) {
				super(self, object, settings);
			}
		}
		Document.Model = self;
		this.serializer = new Serializer();
		this.Document = Document;
		(this.Document as any).table = {
			"create": {
				"request": (): Promise<DynamoDB.CreateTableInput> => createTableRequest(this)
			}
		};

		(this.Document as any).transaction = [
			// `function` Default: `this[key]`
			// `settingsIndex` Default: 1
			// `dynamoKey` Default: utils.capitalize_first_letter(key)
			{"key": "get"},
			{"key": "create", "dynamoKey": "Put"},
			{"key": "delete"},
			{"key": "update", "settingsIndex": 2, "modifier": (response: DynamoDB.UpdateItemInput): DynamoDB.UpdateItemInput => {
				delete response.ReturnValues;
				return response;
			}},
			{"key": "condition", "settingsIndex": -1, "dynamoKey": "ConditionCheck", "function": (key: string, condition: Condition): DynamoDB.ConditionCheck => ({
				"Key": this.Document.objectToDynamo(this.convertObjectToKey(key)),
				"TableName": this.name,
				...condition ? condition.requestObject() : {}
			} as any)}
		].reduce((accumulator: ObjectType, currentValue) => {
			const {key, modifier} = currentValue;
			const dynamoKey = currentValue.dynamoKey || utils.capitalize_first_letter(key);
			const settingsIndex = currentValue.settingsIndex || 1;
			const func = currentValue.function || this[key].bind(this);

			accumulator[key] = async (...args): Promise<DynamoDB.TransactWriteItem> => {
				if (typeof args[args.length - 1] === "function") {
					console.warn("Dynamoose Warning: Passing callback function into transaction method not allowed. Removing callback function from list of arguments.");
					args.pop();
				}

				if (settingsIndex >= 0) {
					args[settingsIndex] = utils.merge_objects({"return": "request"}, args[settingsIndex] || {});
				}
				let result = await func(...args);
				if (modifier) {
					result = modifier(result);
				}
				return {[dynamoKey]: result};
			};

			return accumulator;
		}, {});

		const ModelStore = require("../ModelStore");
		ModelStore(this);
	}

	name: string;
	originalName: string; // Name without prefixes
	options: ModelOptions;
	schemas: Schema[];
	serializer: Serializer;
	private ready: boolean;
	alreadyCreated: boolean;
	private pendingTasks: ((value?: void | PromiseLike<void>) => void)[];
	latestTableDetails: DynamoDB.DescribeTableOutput;
	pendingTaskPromise: () => Promise<void>;
	static defaults: ModelOptions;
	Document: typeof DocumentCarrier;
	scan: (object?: ConditionInitalizer) => Scan<T>;
	query: (object?: ConditionInitalizer) => Query<T>;
	methods: { document: { set: (name: string, fn: FunctionType) => void; delete: (name: string) => void }; set: (name: string, fn: FunctionType) => void; delete: (name: string) => void };
	transaction: TransactionType;

	// This function returns the best matched schema for the given object input
	async schemaForObject (object: ObjectType): Promise<Schema> {
		const schemaCorrectnessScores: number[] = this.schemas.map((schema) => schema.getTypePaths(object, {"type": "toDynamo", "includeAllProperties": true})).map((obj) => Object.values(obj).map((obj) => obj?.matchCorrectness || 0)).map((array) => Math.min(...array));
		const highestSchemaCorrectnessScoreIndex: number = schemaCorrectnessScores.indexOf(Math.max(...schemaCorrectnessScores));

		return this.schemas[highestSchemaCorrectnessScoreIndex];
	}

	async getIndexes (): Promise<ModelIndexes> {
		return (await Promise.all(this.schemas.map((schema) => schema.getIndexes(this)))).reduce((result, indexes) => {
			Object.entries(indexes).forEach((entry) => {
				const [key, value] = entry;
				result[key] = result[key] ? utils.unique_array_elements([...result[key], ...value]) : value;
			});

			return result;
		}, {});
	}
	async getCreateTableAttributeParams (): Promise<Pick<DynamoDB.CreateTableInput, "AttributeDefinitions" | "KeySchema" | "GlobalSecondaryIndexes" | "LocalSecondaryIndexes">> {
		// TODO: implement this
		return this.schemas[0].getCreateTableAttributeParams(this);
	}
	getHashKey (): string {
		return this.schemas[0].getHashKey();
	}
	getRangeKey (): string | void {
		return this.schemas[0].getRangeKey();
	}
	convertObjectToKey (key: InputKey): KeyObject {
		let keyObject: KeyObject;
		const hashKey = this.getHashKey();
		if (typeof key === "object") {
			const rangeKey = this.getRangeKey();
			keyObject = {
				[hashKey]: key[hashKey]
			};
			if (rangeKey && typeof key[rangeKey] !== "undefined" && key[rangeKey] !== null) {
				keyObject[rangeKey] = key[rangeKey];
			}
		} else {
			keyObject = {
				[hashKey]: key
			};
		}
		return keyObject;
	}

	// Batch Get
	batchGet (keys: InputKey[]): Promise<ModelBatchGetDocumentsResponse<T>>;
	batchGet (keys: InputKey[], callback: CallbackType<ModelBatchGetDocumentsResponse<T>, AWSError>): void;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings & {"return": "request"}): DynamoDB.BatchGetItemInput;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings & {"return": "request"}, callback: CallbackType<DynamoDB.BatchGetItemInput, AWSError>): void;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings): Promise<ModelBatchGetDocumentsResponse<T>>;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings, callback: CallbackType<ModelBatchGetDocumentsResponse<T>, AWSError>): void;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings & {"return": "documents"}): Promise<ModelBatchGetDocumentsResponse<T>>;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings & {"return": "documents"}, callback: CallbackType<ModelBatchGetDocumentsResponse<T>, AWSError>): void;
	batchGet (keys: InputKey[], settings?: ModelBatchGetSettings | CallbackType<ModelBatchGetDocumentsResponse<T>, AWSError> | CallbackType<DynamoDB.BatchGetItemInput, AWSError>, callback?: CallbackType<ModelBatchGetDocumentsResponse<T>, AWSError> | CallbackType<DynamoDB.BatchGetItemInput, AWSError>): void | DynamoDB.BatchGetItemInput | Promise<ModelBatchGetDocumentsResponse<T>> {
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "documents"};
		}
		if (typeof settings === "undefined") {
			settings = {"return": "documents"};
		}

		const keyObjects = keys.map((key) => this.convertObjectToKey(key));

		const documentify = (document: DynamoDB.AttributeMap): Promise<DocumentCarrier> => new this.Document(document as any, {"type": "fromDynamo"}).conformToSchema({"customTypesDynamo": true, "checkExpiredItem": true, "saveUnknown": true, "modifiers": ["get"], "type": "fromDynamo"});
		const prepareResponse = async (response: DynamoDB.BatchGetItemOutput): Promise<ModelBatchGetDocumentsResponse<DocumentCarrier>> => {
			const tmpResult = await Promise.all(response.Responses[this.name].map((item) => documentify(item)));
			const unprocessedArray = response.UnprocessedKeys[this.name] ? response.UnprocessedKeys[this.name].Keys : [];
			const tmpResultUnprocessed = await Promise.all(unprocessedArray.map((item) => this.Document.fromDynamo(item)));
			const startArray: ModelBatchGetDocumentsResponse<DocumentCarrier> = Object.assign([], {
				"unprocessedKeys": [],
				"populate": PopulateDocuments,
				"toJSON": utils.dynamoose.documentToJSON
			});
			return keyObjects.reduce((result, key) => {
				const keyProperties = Object.keys(key);
				const item = tmpResult.find((item) => keyProperties.every((keyProperty) => item[keyProperty] === key[keyProperty]));
				if (item) {
					result.push(item);
				} else {
					const item = tmpResultUnprocessed.find((item) => keyProperties.every((keyProperty) => item[keyProperty] === key[keyProperty]));
					if (item) {
						result.unprocessedKeys.push(item);
					}
				}
				return result;
			}, startArray);
		};

		const params: DynamoDB.BatchGetItemInput = {
			"RequestItems": {
				[this.name]: {
					"Keys": keyObjects.map((key) => this.Document.objectToDynamo(key))
				}
			}
		};
		if (settings.attributes) {
			params.RequestItems[this.name].AttributesToGet = settings.attributes;
		}
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.BatchGetItemInput, AWSError> = callback as CallbackType<DynamoDB.BatchGetItemInput, AWSError>;
				localCallback(null, params);
				return;
			} else {
				return params;
			}
		}
		const promise = this.pendingTaskPromise().then(() => ddb("batchGetItem", params));

		if (callback) {
			const localCallback: CallbackType<DocumentCarrier[], AWSError> = callback as CallbackType<DocumentCarrier[], AWSError>;
			promise.then((response) => prepareResponse(response)).then((response) => localCallback(null, response)).catch((error) => localCallback(error));
		} else {
			return (async (): Promise<ModelBatchGetDocumentsResponse<T>> => {
				const response = await promise;
				return prepareResponse(response) as Promise<ModelBatchGetDocumentsResponse<T>>;
			})();
		}
	}

	// Batch Put
	batchPut (documents: ObjectType[]): Promise<{"unprocessedItems": ObjectType[]}>;
	batchPut (documents: ObjectType[], callback: CallbackType<{"unprocessedItems": ObjectType[]}, AWSError>): void;
	batchPut (documents: ObjectType[], settings: ModelBatchPutSettings & {"return": "request"}): Promise<DynamoDB.BatchWriteItemInput>;
	batchPut (documents: ObjectType[], settings: ModelBatchPutSettings & {"return": "request"}, callback: CallbackType<DynamoDB.BatchWriteItemInput, AWSError>): void;
	batchPut (documents: ObjectType[], settings: ModelBatchPutSettings): Promise<{"unprocessedItems": ObjectType[]}>;
	batchPut (documents: ObjectType[], settings: ModelBatchPutSettings, callback: CallbackType<{"unprocessedItems": ObjectType[]}, AWSError>): void;
	batchPut (documents: ObjectType[], settings: ModelBatchPutSettings & {"return": "response"}): Promise<{"unprocessedItems": ObjectType[]}>;
	batchPut (documents: ObjectType[], settings: ModelBatchPutSettings & {"return": "response"}, callback: CallbackType<{"unprocessedItems": ObjectType[]}, AWSError>): void;
	batchPut (documents: ObjectType[], settings?: ModelBatchPutSettings | CallbackType<{"unprocessedItems": ObjectType[]}, AWSError> | CallbackType<DynamoDB.BatchWriteItemInput, AWSError>, callback?: CallbackType<{"unprocessedItems": ObjectType[]}, AWSError> | CallbackType<DynamoDB.BatchWriteItemInput, AWSError>): void | Promise<DynamoDB.BatchWriteItemInput | {"unprocessedItems": ObjectType[]}> {
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "response"};
		}
		if (typeof settings === "undefined") {
			settings = {"return": "response"};
		}

		const prepareResponse = async (response: DynamoDB.BatchWriteItemOutput): Promise<{unprocessedItems: ObjectType[]}> => {
			const unprocessedArray = response.UnprocessedItems && response.UnprocessedItems[this.name] ? response.UnprocessedItems[this.name] : [];
			const tmpResultUnprocessed = await Promise.all(unprocessedArray.map((item) => this.Document.fromDynamo(item.PutRequest.Item)));
			return documents.reduce((result: {unprocessedItems: ObjectType[]}, document) => {
				const item = tmpResultUnprocessed.find((item) => Object.keys(document).every((keyProperty) => item[keyProperty] === document[keyProperty]));
				if (item) {
					result.unprocessedItems.push(item);
				}
				return result;
			}, {"unprocessedItems": []}) as {unprocessedItems: ObjectType[]};
		};

		const paramsPromise: Promise<DynamoDB.BatchWriteItemInput> = (async (): Promise<DynamoDB.BatchWriteItemInput> => ({
			"RequestItems": {
				[this.name]: await Promise.all(documents.map(async (document) => ({
					"PutRequest": {
						"Item": await new this.Document(document as any).toDynamo({"defaults": true, "validate": true, "required": true, "enum": true, "forceDefault": true, "saveUnknown": true, "combine": true, "customTypesDynamo": true, "updateTimestamps": true, "modifiers": ["set"]})
					}
				})))
			}
		}))();
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.BatchWriteItemInput, AWSError> = callback as CallbackType<DynamoDB.BatchWriteItemInput, AWSError>;
				paramsPromise.then((result) => localCallback(null, result));
				return;
			} else {
				return paramsPromise;
			}
		}
		const promise = this.pendingTaskPromise().then(() => paramsPromise).then((params) => ddb("batchWriteItem", params));

		if (callback) {
			const localCallback: CallbackType<{"unprocessedItems": ObjectType[]}, AWSError> = callback as CallbackType<{"unprocessedItems": ObjectType[]}, AWSError>;
			promise.then((response) => prepareResponse(response)).then((response) => localCallback(null, response)).catch((error) => callback(error));
		} else {
			return (async (): Promise<{unprocessedItems: ObjectType[]}> => {
				const response = await promise;
				return prepareResponse(response);
			})();
		}
	}

	// Batch Delete
	batchDelete (keys: InputKey[]): Promise<{unprocessedItems: ObjectType[]}>;
	batchDelete (keys: InputKey[], callback: CallbackType<{unprocessedItems: ObjectType[]}, AWSError>): void;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings & {"return": "request"}): DynamoDB.BatchWriteItemInput;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings & {"return": "request"}, callback: CallbackType<DynamoDB.BatchWriteItemInput, AWSError>): void;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings): Promise<{unprocessedItems: ObjectType[]}>;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings, callback: CallbackType<{unprocessedItems: ObjectType[]}, AWSError>): Promise<{unprocessedItems: ObjectType[]}>;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings & {"return": "response"}): Promise<{unprocessedItems: ObjectType[]}>;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings & {"return": "response"}, callback: CallbackType<{unprocessedItems: ObjectType[]}, AWSError>): Promise<{unprocessedItems: ObjectType[]}>;
	batchDelete (keys: InputKey[], settings?: ModelBatchDeleteSettings | CallbackType<{unprocessedItems: ObjectType[]}, AWSError> | CallbackType<DynamoDB.BatchWriteItemInput, AWSError>, callback?: CallbackType<{unprocessedItems: ObjectType[]}, AWSError> | CallbackType<DynamoDB.BatchWriteItemInput, AWSError>): void | DynamoDB.BatchWriteItemInput | Promise<{unprocessedItems: ObjectType[]}> {
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "response"};
		}
		if (typeof settings === "undefined") {
			settings = {"return": "response"};
		}

		const keyObjects: KeyObject[] = keys.map((key) => this.convertObjectToKey(key));

		const prepareResponse = async (response: DynamoDB.BatchWriteItemOutput): Promise<{unprocessedItems: ObjectType[]}> => {
			const unprocessedArray = response.UnprocessedItems && response.UnprocessedItems[this.name] ? response.UnprocessedItems[this.name] : [];
			const tmpResultUnprocessed = await Promise.all(unprocessedArray.map((item) => this.Document.fromDynamo(item.DeleteRequest.Key)));
			return keyObjects.reduce((result, key) => {
				const item = tmpResultUnprocessed.find((item) => Object.keys(key).every((keyProperty) => item[keyProperty] === key[keyProperty]));
				if (item) {
					result.unprocessedItems.push(item);
				}
				return result;
			}, {"unprocessedItems": []});
		};

		const params: DynamoDB.BatchWriteItemInput = {
			"RequestItems": {
				[this.name]: keyObjects.map((key) => ({
					"DeleteRequest": {
						"Key": this.Document.objectToDynamo(key)
					}
				}))
			}
		};
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.BatchWriteItemInput, AWSError> = callback as CallbackType<DynamoDB.BatchWriteItemInput, AWSError>;
				localCallback(null, params);
				return;
			} else {
				return params;
			}
		}
		const promise = this.pendingTaskPromise().then(() => ddb("batchWriteItem", params));

		if (callback) {
			const localCallback: CallbackType<{"unprocessedItems": ObjectType[]}, AWSError> = callback as CallbackType<{"unprocessedItems": ObjectType[]}, AWSError>;
			promise.then((response) => prepareResponse(response)).then((response) => localCallback(null, response)).catch((error) => localCallback(error));
		} else {
			return (async (): Promise<{unprocessedItems: ObjectType[]}> => {
				const response = await promise;
				return prepareResponse(response);
			})();
		}
	}

	// Update
	update (obj: Partial<T>): Promise<T>;
	update (obj: Partial<T>, callback: CallbackType<T, AWSError>): void;
	update (keyObj: ObjectType, updateObj: Partial<T>): Promise<T>;
	update (keyObj: ObjectType, updateObj: Partial<T>, callback: CallbackType<T, AWSError>): void;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings & {"return": "request"}): Promise<DynamoDB.UpdateItemInput>;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings & {"return": "request"}, callback: CallbackType<DynamoDB.UpdateItemInput, AWSError>): void;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings): Promise<T>;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings, callback: CallbackType<T, AWSError>): void;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings & {"return": "document"}): Promise<T>;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings & {"return": "document"}, callback: CallbackType<T, AWSError>): void;
	update (keyObj: ObjectType, updateObj?: Partial<T> | CallbackType<T, AWSError> | CallbackType<DynamoDB.UpdateItemInput, AWSError>, settings?: ModelUpdateSettings | CallbackType<T, AWSError> | CallbackType<DynamoDB.UpdateItemInput, AWSError>, callback?: CallbackType<T, AWSError> | CallbackType<DynamoDB.UpdateItemInput, AWSError>): void | Promise<T> | Promise<DynamoDB.UpdateItemInput> {
		if (typeof updateObj === "function") {
			callback = updateObj as CallbackType<DocumentCarrier | DynamoDB.UpdateItemInput, AWSError>; // TODO: fix this, for some reason `updateObj` has a type of Function which is forcing us to type cast it
			updateObj = null;
			settings = {"return": "document"};
		}
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "document"};
		}
		if (!updateObj) {
			const hashKeyName = this.getHashKey();
			updateObj = keyObj as Partial<T>;
			keyObj = {
				[hashKeyName]: keyObj[hashKeyName]
			};
			delete updateObj[hashKeyName];

			const rangeKeyName = this.getRangeKey();
			if (rangeKeyName) {
				keyObj[rangeKeyName] = updateObj[rangeKeyName];
				delete updateObj[rangeKeyName];
			}
		}
		if (typeof settings === "undefined") {
			settings = {"return": "document"};
		}

		const schema: Schema = this.schemas[0]; // TODO: fix this to get correct schema
		let index = 0;
		const getUpdateExpressionObject: () => Promise<any> = async () => {
			const updateTypes = [
				{"name": "$SET", "operator": " = ", "objectFromSchemaSettings": {"validate": true, "enum": true, "forceDefault": true, "required": "nested", "modifiers": ["set"]}},
				{"name": "$ADD", "objectFromSchemaSettings": {"forceDefault": true}},
				{"name": "$REMOVE", "attributeOnly": true, "objectFromSchemaSettings": {"required": true, "defaults": true}},
				{"name": "$DELETE", "objectFromSchemaSettings": {"defaults": true}}
			].reverse();
			const returnObject = await Object.keys(updateObj).reduce(async (accumulatorPromise, key) => {
				const accumulator = await accumulatorPromise;
				let value = updateObj[key];

				if (!(typeof value === "object" && updateTypes.map((a) => a.name).includes(key))) {
					value = {[key]: value};
					key = "$SET";
				}

				const valueKeys = Object.keys(value);
				for (let i = 0; i < valueKeys.length; i++) {
					let subKey = valueKeys[i];
					let subValue = value[subKey];

					let updateType = updateTypes.find((a) => a.name === key);

					const expressionKey = `#a${index}`;
					subKey = Array.isArray(value) ? subValue : subKey;

					let dynamoType;
					try {
						dynamoType = schema.getAttributeType(subKey, subValue, {"unknownAttributeAllowed": true});
					} catch (e) {} // eslint-disable-line no-empty
					const attributeExists = schema.attributes().includes(subKey);
					const dynamooseUndefined = require("../index").UNDEFINED;
					if (!updateType.attributeOnly && subValue !== dynamooseUndefined) {
						subValue = (await this.Document.objectFromSchema({[subKey]: dynamoType === "L" && !Array.isArray(subValue) ? [subValue] : subValue}, this, {"type": "toDynamo", "customTypesDynamo": true, "saveUnknown": true, ...updateType.objectFromSchemaSettings} as any))[subKey];
					}

					if (subValue === dynamooseUndefined || subValue === undefined) {
						if (attributeExists) {
							updateType = updateTypes.find((a) => a.name === "$REMOVE");
						} else {
							continue;
						}
					}

					if (subValue !== dynamooseUndefined) {
						const defaultValue = await schema.defaultCheck(subKey, undefined, updateType.objectFromSchemaSettings);
						if (defaultValue) {
							subValue = defaultValue;
							updateType = updateTypes.find((a) => a.name === "$SET");
						}
					}

					if (updateType.objectFromSchemaSettings.required === true) {
						await schema.requiredCheck(subKey, undefined);
					}

					let expressionValue = updateType.attributeOnly ? "" : `:v${index}`;
					accumulator.ExpressionAttributeNames[expressionKey] = subKey;
					if (!updateType.attributeOnly) {
						accumulator.ExpressionAttributeValues[expressionValue] = subValue;
					}

					if (dynamoType === "L" && updateType.name === "$ADD") {
						expressionValue = `list_append(${expressionKey}, ${expressionValue})`;
						updateType = updateTypes.find((a) => a.name === "$SET");
					}

					const operator = updateType.operator || (updateType.attributeOnly ? "" : " ");

					accumulator.UpdateExpression[updateType.name.slice(1)].push(`${expressionKey}${operator}${expressionValue}`);

					index++;
				}

				return accumulator;
			}, Promise.resolve((async (): Promise<{ExpressionAttributeNames: ObjectType; ExpressionAttributeValues: ObjectType; UpdateExpression: ObjectType}> => {
				const obj = {
					"ExpressionAttributeNames": {},
					"ExpressionAttributeValues": {},
					"UpdateExpression": updateTypes.map((a) => a.name).reduce((accumulator, key) => {
						accumulator[key.slice(1)] = [];
						return accumulator;
					}, {})
				};

				const documentFunctionSettings: DocumentObjectFromSchemaSettings = {"updateTimestamps": {"updatedAt": true}, "customTypesDynamo": true, "type": "toDynamo"};
				const defaultObjectFromSchema = await this.Document.objectFromSchema(await this.Document.prepareForObjectFromSchema({}, this, documentFunctionSettings), this, documentFunctionSettings);
				Object.keys(defaultObjectFromSchema).forEach((key) => {
					const value = defaultObjectFromSchema[key];
					const updateType = updateTypes.find((a) => a.name === "$SET");

					obj.ExpressionAttributeNames[`#a${index}`] = key;
					obj.ExpressionAttributeValues[`:v${index}`] = value;
					obj.UpdateExpression[updateType.name.slice(1)].push(`#a${index}${updateType.operator}:v${index}`);

					index++;
				});

				return obj;
			})()));

			schema.attributes().map((attribute) => ({attribute, "type": schema.getAttributeTypeDetails(attribute)})).filter((item: any) => {
				return Array.isArray(item.type) ? item.type.some((type) => type.name === "Combine") : item.type.name === "Combine";
			}).map((details) => {
				const {type} = details;

				if (Array.isArray(type)) {
					throw new CustomError.InvalidParameter("Combine type is not allowed to be used with multiple types.");
				}

				return details;
			}).forEach((details: any) => {
				const {invalidAttributes} = details.type.typeSettings.attributes.reduce((result, attribute) => {
					const expressionAttributeNameEntry = Object.entries(returnObject.ExpressionAttributeNames).find((entry) => entry[1] === attribute);
					const doesExist = Boolean(expressionAttributeNameEntry);
					const isValid = doesExist && [...returnObject.UpdateExpression.SET, ...returnObject.UpdateExpression.REMOVE].join(", ").includes(expressionAttributeNameEntry[0]);

					if (!isValid) {
						result.invalidAttributes.push(attribute);
					}

					return result;
				}, {"invalidAttributes": []});

				if (invalidAttributes.length > 0) {
					throw new CustomError.InvalidParameter(`You must update all or none of the combine attributes when running Model.update. Missing combine attributes: ${invalidAttributes.join(", ")}.`);
				} else {
					const nextIndex = Math.max(...Object.keys(returnObject.ExpressionAttributeNames).map((key) => parseInt(key.replace("#a", "")))) + 1;
					returnObject.ExpressionAttributeNames[`#a${nextIndex}`] = details.attribute;
					returnObject.ExpressionAttributeValues[`:v${nextIndex}`] = details.type.typeSettings.attributes.map((attribute) => {
						const [expressionAttributeNameKey] = Object.entries(returnObject.ExpressionAttributeNames).find((entry) => entry[1] === attribute);
						return returnObject.ExpressionAttributeValues[expressionAttributeNameKey.replace("#a", ":v")];
					}).filter((value) => typeof value !== "undefined" && value !== null).join(details.type.typeSettings.seperator);
					returnObject.UpdateExpression.SET.push(`#a${nextIndex} = :v${nextIndex}`);
				}
			});

			await Promise.all(schema.attributes().map(async (attribute) => {
				const defaultValue = await schema.defaultCheck(attribute, undefined, {"forceDefault": true});
				if (defaultValue && !Object.values(returnObject.ExpressionAttributeNames).includes(attribute)) {
					const updateType = updateTypes.find((a) => a.name === "$SET");

					returnObject.ExpressionAttributeNames[`#a${index}`] = attribute;
					returnObject.ExpressionAttributeValues[`:v${index}`] = defaultValue;
					returnObject.UpdateExpression[updateType.name.slice(1)].push(`#a${index}${updateType.operator}:v${index}`);

					index++;
				}
			}));

			Object.values(returnObject.ExpressionAttributeNames).map((attribute: string, index) => {
				const value: ValueType = Object.values(returnObject.ExpressionAttributeValues)[index];
				const valueKey = Object.keys(returnObject.ExpressionAttributeValues)[index];
				let dynamoType;
				try {
					dynamoType = schema.getAttributeType(attribute, value, {"unknownAttributeAllowed": true});
				} catch (e) {} // eslint-disable-line no-empty
				const attributeType = Schema.attributeTypes.findDynamoDBType(dynamoType) as DynamoDBSetTypeResult;

				if (attributeType?.toDynamo && !attributeType.isOfType(value, "fromDynamo")) {
					returnObject.ExpressionAttributeValues[valueKey] = attributeType.toDynamo(value as any);
				}
			});

			returnObject.ExpressionAttributeValues = this.Document.objectToDynamo(returnObject.ExpressionAttributeValues);
			if (Object.keys(returnObject.ExpressionAttributeValues).length === 0) {
				delete returnObject.ExpressionAttributeValues;
			}

			return {
				...returnObject,
				"UpdateExpression": Object.keys(returnObject.UpdateExpression).reduce((accumulator, key) => {
					const value = returnObject.UpdateExpression[key];

					if (value.length > 0) {
						return `${accumulator}${accumulator.length > 0 ? " " : ""}${key} ${value.join(", ")}`;
					} else {
						return accumulator;
					}
				}, "")
			};
		};

		const documentify = (document): Promise<any> => new this.Document(document, {"type": "fromDynamo"}).conformToSchema({"customTypesDynamo": true, "checkExpiredItem": true, "type": "fromDynamo", "saveUnknown": true});
		const localSettings: ModelUpdateSettings = settings;
		const updateItemParamsPromise: Promise<DynamoDB.UpdateItemInput> = this.pendingTaskPromise().then(async () => ({
			"Key": this.Document.objectToDynamo(keyObj),
			"ReturnValues": localSettings.returnValues || "ALL_NEW",
			...utils.merge_objects.main({"combineMethod": "object_combine"})(localSettings.condition ? localSettings.condition.requestObject({"index": {"start": index, "set": (i): void => {
				index = i;
			}}, "conditionString": "ConditionExpression", "conditionStringType": "string"}) : {}, await getUpdateExpressionObject()),
			"TableName": this.name
		}));
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.UpdateItemInput, AWSError> = callback as CallbackType<DynamoDB.UpdateItemInput, AWSError>;
				updateItemParamsPromise.then((params) => localCallback(null, params));
				return;
			} else {
				return updateItemParamsPromise;
			}
		}
		const promise = updateItemParamsPromise.then((params) => ddb("updateItem", params));

		if (callback) {
			promise.then((response) => response.Attributes ? documentify(response.Attributes) : undefined).then((response) => callback(null, response)).catch((error) => callback(error));
		} else {
			return (async (): Promise<any> => {
				const response = await promise;
				return response.Attributes ? await documentify(response.Attributes) : undefined;
			})();
		}
	}

	// Create
	create (document: Partial<T>): Promise<T>;
	create (document: Partial<T>, callback: CallbackType<T, AWSError>): void;
	create (document: Partial<T>, settings: DocumentSaveSettings & {return: "request"}): Promise<DynamoDB.PutItemInput>;
	create (document: Partial<T>, settings: DocumentSaveSettings & {return: "request"}, callback: CallbackType<DynamoDB.PutItemInput, AWSError>): void;
	create (document: Partial<T>, settings: DocumentSaveSettings): Promise<T>;
	create (document: Partial<T>, settings: DocumentSaveSettings, callback: CallbackType<T, AWSError>): void;
	create (document: Partial<T>, settings: DocumentSaveSettings & {return: "document"}): Promise<T>;
	create (document: Partial<T>, settings: DocumentSaveSettings & {return: "document"}, callback: CallbackType<T, AWSError>): void;
	create (document: Partial<T>, settings?: DocumentSaveSettings | CallbackType<T, AWSError> | CallbackType<DynamoDB.PutItemInput, AWSError>, callback?: CallbackType<T, AWSError> | CallbackType<DynamoDB.PutItemInput, AWSError>): void | Promise<T> | Promise<DynamoDB.PutItemInput> {
		if (typeof settings === "function" && !callback) {
			callback = settings;
			settings = {};
		}

		return new this.Document(document as any).save({"overwrite": false, ...settings} as any, callback as any);
	}

	// Delete
	delete (key: InputKey): Promise<void>;
	delete (key: InputKey, callback: CallbackType<void, AWSError>): void;
	delete (key: InputKey, settings: ModelDeleteSettings & {return: "request"}): DynamoDB.DeleteItemInput;
	delete (key: InputKey, settings: ModelDeleteSettings & {return: "request"}, callback: CallbackType<DynamoDB.DeleteItemInput, AWSError>): void;
	delete (key: InputKey, settings: ModelDeleteSettings): Promise<void>;
	delete (key: InputKey, settings: ModelDeleteSettings, callback: CallbackType<void, AWSError>): void;
	delete (key: InputKey, settings: ModelDeleteSettings & {return: null}): Promise<void>;
	delete (key: InputKey, settings: ModelDeleteSettings & {return: null}, callback: CallbackType<void, AWSError>): void;
	delete (key: InputKey, settings?: ModelDeleteSettings | CallbackType<void, AWSError> | CallbackType<DynamoDB.DeleteItemInput, AWSError>, callback?: CallbackType<void, AWSError> | CallbackType<DynamoDB.DeleteItemInput, AWSError>): void | DynamoDB.DeleteItemInput | Promise<void> {
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": null};
		}
		if (typeof settings === "undefined") {
			settings = {"return": null};
		}
		if (typeof settings === "object" && !settings.return) {
			settings = {...settings, "return": null};
		}

		let deleteItemParams: DynamoDB.DeleteItemInput = {
			"Key": this.Document.objectToDynamo(this.convertObjectToKey(key)),
			"TableName": this.name
		};

		if (settings.condition) {
			deleteItemParams = {
				...deleteItemParams,
				...settings.condition.requestObject()
			};
		}

		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.DeleteItemInput, AWSError> = callback as CallbackType<DynamoDB.DeleteItemInput, AWSError>;
				localCallback(null, deleteItemParams);
				return;
			} else {
				return deleteItemParams;
			}
		}
		const promise = this.pendingTaskPromise().then(() => ddb("deleteItem", deleteItemParams));

		if (callback) {
			promise.then(() => callback()).catch((error) => callback(error));
		} else {
			return (async (): Promise<void> => {
				await promise;
			})();
		}
	}

	// Get
	get (key: InputKey): Promise<T>;
	get (key: InputKey, callback: CallbackType<T, AWSError>): void;
	get (key: InputKey, settings: ModelGetSettings & {return: "request"}): DynamoDB.GetItemInput;
	get (key: InputKey, settings: ModelGetSettings & {return: "request"}, callback: CallbackType<DynamoDB.GetItemInput, AWSError>): void;
	get (key: InputKey, settings: ModelGetSettings): Promise<T>;
	get (key: InputKey, settings: ModelGetSettings, callback: CallbackType<T, AWSError>): void;
	get (key: InputKey, settings: ModelGetSettings & {return: "document"}): Promise<T>;
	get (key: InputKey, settings: ModelGetSettings & {return: "document"}, callback: CallbackType<T, AWSError>): void;
	get (key: InputKey, settings?: ModelGetSettings | CallbackType<T, AWSError> | CallbackType<DynamoDB.GetItemInput, AWSError>, callback?: CallbackType<T, AWSError> | CallbackType<DynamoDB.GetItemInput, AWSError>): void | DynamoDB.GetItemInput | Promise<T> {
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "document"};
		}
		if (typeof settings === "undefined") {
			settings = {"return": "document"};
		}

		const conformToSchemaSettings: DocumentObjectFromSchemaSettings = {"customTypesDynamo": true, "checkExpiredItem": true, "saveUnknown": true, "modifiers": ["get"], "type": "fromDynamo"};
		const documentify = (document: DynamoDB.AttributeMap): Promise<DocumentCarrier> => new this.Document(document as any, {"type": "fromDynamo"}).conformToSchema(conformToSchemaSettings);

		const getItemParams: DynamoDB.GetItemInput = {
			"Key": this.Document.objectToDynamo(this.convertObjectToKey(key)),
			"TableName": this.name
		};
		if (settings.consistent !== undefined && settings.consistent !== null) {
			getItemParams.ConsistentRead = settings.consistent;
		}
		if (settings.attributes) {
			getItemParams.ProjectionExpression = settings.attributes.map((attribute, index) => `#a${index}`).join(", ");
			getItemParams.ExpressionAttributeNames = settings.attributes.reduce((accumulator, currentValue, index) => (accumulator[`#a${index}`] = currentValue, accumulator), {});
		}
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.GetItemInput, AWSError> = callback as CallbackType<DynamoDB.GetItemInput, AWSError>;
				localCallback(null, getItemParams);
				return;
			} else {
				return getItemParams;
			}
		}
		const promise = this.pendingTaskPromise().then(() => ddb("getItem", getItemParams));

		if (callback) {
			const localCallback: CallbackType<DocumentCarrier, AWSError> = callback as CallbackType<DocumentCarrier, AWSError>;
			promise.then((response) => response.Item ? documentify(response.Item) : undefined).then((response) => localCallback(null, response)).catch((error) => callback(error));
		} else {
			return (async (): Promise<any> => {
				const response = await promise;
				return response.Item ? await documentify(response.Item) : undefined;
			})();
		}
	}

	// Serialize Many
	serializeMany (documentsArray: ModelType<DocumentCarrier>[] = [], nameOrOptions: SerializerOptions | string): any {
		return this.serializer._serializeMany(documentsArray, nameOrOptions);
	}
}

Model.defaults = originalDefaults;


Model.prototype.scan = function (object?: ConditionInitalizer): Scan<DocumentCarrier> {
	return new Scan(this, object);
};
Model.prototype.query = function (object?: ConditionInitalizer): Query<DocumentCarrier> {
	return new Query(this, object);
};

// Methods
const customMethodFunctions = (type: "model" | "document"): {set: (name: string, fn: FunctionType) => void; delete: (name: string) => void} => {
	const entryPoint = (self: Model<DocumentCarrier>): DocumentCarrier | typeof DocumentCarrier => type === "document" ? self.Document.prototype : self.Document;
	return {
		"set": function (name: string, fn): void {
			const self: Model<DocumentCarrier> = this as any;
			if (!entryPoint(self)[name] || entryPoint(self)[name][Internal.General.internalProperties] && entryPoint(self)[name][Internal.General.internalProperties].type === "customMethod") {
				entryPoint(self)[name] = function (...args): Promise<any> {
					const bindObject = type === "document" ? this : self.Document;
					const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
					if (cb) {
						const result = fn.bind(bindObject)(...args);
						if (result instanceof Promise) {
							result.then((result) => cb(null, result)).catch((err) => cb(err));
						}
					} else {
						return new Promise((resolve, reject) => {
							const result = fn.bind(bindObject)(...args, (err, result) => {
								if (err) {
									reject(err);
								} else {
									resolve(result);
								}
							});
							if (result instanceof Promise) {
								result.then(resolve).catch(reject);
							}
						});
					}
				};
				entryPoint(self)[name][Internal.General.internalProperties] = {"type": "customMethod"};
			}
		},
		"delete": function (name: string): void {
			const self: Model<DocumentCarrier> = this as any;
			if (entryPoint(self)[name] && entryPoint(self)[name][Internal.General.internalProperties] && entryPoint(self)[name][Internal.General.internalProperties].type === "customMethod") {
				entryPoint(self)[name] = undefined;
			}
		}
	};
};
Model.prototype.methods = {
	...customMethodFunctions("model"),
	"document": customMethodFunctions("document")
};
