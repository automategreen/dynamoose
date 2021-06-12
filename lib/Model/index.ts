import CustomError = require("../Error");
import {Schema, SchemaDefinition, DynamoDBSetTypeResult, ValueType, IndexItem} from "../Schema";
import {Item as ItemCarrier, ItemSaveSettings, ItemSettings, ItemObjectFromSchemaSettings, AnyItem} from "../Item";
import utils = require("../utils");
import ddb = require("../aws/ddb/internal");
import Internal = require("../Internal");
import {Serializer, SerializerOptions} from "../Serializer";
import {Condition, ConditionInitalizer} from "../Condition";
import {Scan, Query} from "../ItemRetriever";
import {CallbackType, ObjectType, FunctionType, ItemArray, ModelType, KeyObject, InputKey} from "../General";
import {PopulateItems} from "../Populate";
import {AttributeMap} from "../Types";
import DynamoDB = require("@aws-sdk/client-dynamodb");
import {GetTransactionInput, CreateTransactionInput, DeleteTransactionInput, UpdateTransactionInput, ConditionTransactionInput} from "../Transaction";
import {Table} from "../Table";
const {internalProperties} = Internal.General;

// Transactions
type GetTransactionResult = Promise<GetTransactionInput>;
type CreateTransactionResult = Promise<CreateTransactionInput>;
type DeleteTransactionResult = Promise<DeleteTransactionInput>;
type UpdateTransactionResult = Promise<UpdateTransactionInput>;
type ConditionTransactionResult = Promise<ConditionTransactionInput>;

export interface GetTransaction {
	(key: InputKey): GetTransactionResult;
	(key: InputKey, settings?: ModelGetSettings): GetTransactionResult;
	(key: InputKey, settings: ModelGetSettings & {return: "item"}): GetTransactionResult;
	(key: InputKey, settings: ModelGetSettings & {return: "request"}): GetTransactionResult;
}
export interface CreateTransaction {
	(item: ObjectType): CreateTransactionResult;
	(item: ObjectType, settings: ItemSaveSettings & {return: "request"}): CreateTransactionResult;
	(item: ObjectType, settings: ItemSaveSettings & {return: "item"}): CreateTransactionResult;
	(item: ObjectType, settings?: ItemSaveSettings): CreateTransactionResult;
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
	(keyObj: ObjectType, updateObj: ObjectType, settings: ModelUpdateSettings & {"return": "item"}): UpdateTransactionResult;
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


interface ModelGetSettings {
	return?: "item" | "request";
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
	return?: "item" | "request";
	condition?: Condition;
}
interface ModelBatchGetItemsResponse<T> extends ItemArray<T> {
	unprocessedKeys: ObjectType[];
}
interface ModelBatchGetSettings {
	return?: "items" | "request";
	attributes?: string[];
}
interface ModelBatchDeleteSettings {
	return?: "response" | "request";
}

// Model represents a single entity (ex. User, Movie, Video, Order)
export class Model<T extends ItemCarrier = AnyItem> {
	constructor (name: string, schema: Schema | SchemaDefinition | (Schema | SchemaDefinition)[]) {
		Object.defineProperty(this, internalProperties, {
			"configurable": false,
			"value": {}
		});

		Object.defineProperty(this, "name", {
			"configurable": false,
			"value": name
		});

		// Methods
		this[internalProperties].getIndexes = async (): Promise<{GlobalSecondaryIndexes?: IndexItem[]; LocalSecondaryIndexes?: IndexItem[]}> => {
			return (await Promise.all(this[internalProperties].schemas.map((schema) => schema.getIndexes(this)))).reduce((result, indexes) => {
				Object.entries(indexes).forEach((entry) => {
					const [key, value] = entry;
					result[key] = result[key] ? utils.unique_array_elements([...result[key], ...value]) : value;
				});

				return result;
			}, {});
		};
		this[internalProperties].convertObjectToKey = (key: InputKey): KeyObject => {
			let keyObject: KeyObject;
			const hashKey = this[internalProperties].getHashKey();
			if (typeof key === "object") {
				const rangeKey = this[internalProperties].getRangeKey();
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
		};
		// This function returns the best matched schema for the given object input
		this[internalProperties].schemaForObject = async (object: ObjectType): Promise<Schema> => {
			const schemaCorrectnessScores: number[] = this[internalProperties].schemas.map((schema) => schema.getTypePaths(object, {"type": "toDynamo", "includeAllProperties": true})).map((obj) => Object.values(obj).map((obj) => (obj as any)?.matchCorrectness || 0)).map((array) => Math.min(...array));
			const highestSchemaCorrectnessScoreIndex: number = schemaCorrectnessScores.indexOf(Math.max(...schemaCorrectnessScores));

			return this[internalProperties].schemas[highestSchemaCorrectnessScoreIndex];
		};
		this[internalProperties].getCreateTableAttributeParams = async (): Promise<Pick<DynamoDB.CreateTableInput, "AttributeDefinitions" | "KeySchema" | "GlobalSecondaryIndexes" | "LocalSecondaryIndexes">> => {
			// TODO: implement this
			return this[internalProperties].schemas[0].getCreateTableAttributeParams(this);
		};
		this[internalProperties].getHashKey = (): string => {
			return this[internalProperties].schemas[0].getHashKey();
		};
		this[internalProperties].getRangeKey = (): string | void => {
			return this[internalProperties].schemas[0].getRangeKey();
		};

		this[internalProperties].table = (): Table => {
			const table = this[internalProperties]._table;
			if (!table) {
				throw new CustomError.OtherError(`No table has been registered for ${this.name} model. Use \`new dynamoose.Table\` to register a table for this model.`);
			}

			return table;
		};

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
		this[internalProperties].schemas = realSchemas;

		const self: Model<ItemCarrier> = this;
		class Item extends ItemCarrier {
			static Model: Model<ItemCarrier>;
			constructor (object: AttributeMap | ObjectType = {}, settings: ItemSettings = {}) {
				super(self, object, settings);
			}
		}
		Item.Model = self;
		this.Item = Item;

		this.serializer = new Serializer();

		(this.Item as any).transaction = [
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
				"Key": this.Item.objectToDynamo(this[internalProperties].convertObjectToKey(key)),
				"TableName": this[internalProperties].table()[internalProperties].name,
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
	// originalName: string; // Name without prefixes
	// options: ModelOptions;
	// schemas: Schema[];
	serializer: Serializer;
	// private ready: boolean;
	// alreadyCreated: boolean;
	// private pendingTasks: ((value?: void | PromiseLike<void>) => void)[];
	// latestTableDetails: DynamoDB.DescribeTableOutput;
	// pendingTaskPromise: () => Promise<void>;
	Item: typeof ItemCarrier;
	scan: (object?: ConditionInitalizer) => Scan<T>;
	query: (object?: ConditionInitalizer) => Query<T>;
	methods: { item: { set: (name: string, fn: FunctionType) => void; delete: (name: string) => void }; set: (name: string, fn: FunctionType) => void; delete: (name: string) => void };
	transaction: TransactionType;

	// Batch Get
	batchGet (keys: InputKey[]): Promise<ModelBatchGetItemsResponse<T>>;
	batchGet (keys: InputKey[], callback: CallbackType<ModelBatchGetItemsResponse<T>, any>): void;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings & {"return": "request"}): DynamoDB.BatchGetItemInput;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings & {"return": "request"}, callback: CallbackType<DynamoDB.BatchGetItemInput, any>): void;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings): Promise<ModelBatchGetItemsResponse<T>>;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings, callback: CallbackType<ModelBatchGetItemsResponse<T>, any>): void;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings & {"return": "items"}): Promise<ModelBatchGetItemsResponse<T>>;
	batchGet (keys: InputKey[], settings: ModelBatchGetSettings & {"return": "items"}, callback: CallbackType<ModelBatchGetItemsResponse<T>, any>): void;
	batchGet (keys: InputKey[], settings?: ModelBatchGetSettings | CallbackType<ModelBatchGetItemsResponse<T>, any> | CallbackType<DynamoDB.BatchGetItemInput, any>, callback?: CallbackType<ModelBatchGetItemsResponse<T>, any> | CallbackType<DynamoDB.BatchGetItemInput, any>): void | DynamoDB.BatchGetItemInput | Promise<ModelBatchGetItemsResponse<T>> {
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "items"};
		}
		if (typeof settings === "undefined") {
			settings = {"return": "items"};
		}

		const keyObjects = keys.map((key) => this[internalProperties].convertObjectToKey(key));

		const itemify = (item: AttributeMap): Promise<ItemCarrier> => new this.Item(item as any, {"type": "fromDynamo"}).conformToSchema({"customTypesDynamo": true, "checkExpiredItem": true, "saveUnknown": true, "modifiers": ["get"], "type": "fromDynamo"});
		const prepareResponse = async (response: DynamoDB.BatchGetItemOutput): Promise<ModelBatchGetItemsResponse<ItemCarrier>> => {
			const tmpResult = await Promise.all(response.Responses[this[internalProperties].table()[internalProperties].name].map((item) => itemify(item)));
			const unprocessedArray = response.UnprocessedKeys[this[internalProperties].table()[internalProperties].name] ? response.UnprocessedKeys[this[internalProperties].table()[internalProperties].name].Keys : [];
			const tmpResultUnprocessed = await Promise.all(unprocessedArray.map((item) => this.Item.fromDynamo(item)));
			const startArray: ModelBatchGetItemsResponse<ItemCarrier> = Object.assign([], {
				"unprocessedKeys": [],
				"populate": PopulateItems,
				"toJSON": utils.dynamoose.itemToJSON
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
				[this[internalProperties].table()[internalProperties].name]: {
					"Keys": keyObjects.map((key) => this.Item.objectToDynamo(key))
				}
			}
		};
		if (settings.attributes) {
			params.RequestItems[this[internalProperties].table()[internalProperties].name].AttributesToGet = settings.attributes;
		}
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.BatchGetItemInput, any> = callback as CallbackType<DynamoDB.BatchGetItemInput, any>;
				localCallback(null, params);
				return;
			} else {
				return params;
			}
		}
		const promise = this[internalProperties].table()[internalProperties].pendingTaskPromise().then(() => ddb("batchGetItem", params));

		if (callback) {
			const localCallback: CallbackType<ItemCarrier[], any> = callback as CallbackType<ItemCarrier[], any>;
			promise.then((response) => prepareResponse(response)).then((response) => localCallback(null, response)).catch((error) => localCallback(error));
		} else {
			return (async (): Promise<ModelBatchGetItemsResponse<T>> => {
				const response = await promise;
				return prepareResponse(response) as Promise<ModelBatchGetItemsResponse<T>>;
			})();
		}
	}

	// Batch Put
	batchPut (items: ObjectType[]): Promise<{"unprocessedItems": ObjectType[]}>;
	batchPut (items: ObjectType[], callback: CallbackType<{"unprocessedItems": ObjectType[]}, any>): void;
	batchPut (items: ObjectType[], settings: ModelBatchPutSettings & {"return": "request"}): Promise<DynamoDB.BatchWriteItemInput>;
	batchPut (items: ObjectType[], settings: ModelBatchPutSettings & {"return": "request"}, callback: CallbackType<DynamoDB.BatchWriteItemInput, any>): void;
	batchPut (items: ObjectType[], settings: ModelBatchPutSettings): Promise<{"unprocessedItems": ObjectType[]}>;
	batchPut (items: ObjectType[], settings: ModelBatchPutSettings, callback: CallbackType<{"unprocessedItems": ObjectType[]}, any>): void;
	batchPut (items: ObjectType[], settings: ModelBatchPutSettings & {"return": "response"}): Promise<{"unprocessedItems": ObjectType[]}>;
	batchPut (items: ObjectType[], settings: ModelBatchPutSettings & {"return": "response"}, callback: CallbackType<{"unprocessedItems": ObjectType[]}, any>): void;
	batchPut (items: ObjectType[], settings?: ModelBatchPutSettings | CallbackType<{"unprocessedItems": ObjectType[]}, any> | CallbackType<DynamoDB.BatchWriteItemInput, any>, callback?: CallbackType<{"unprocessedItems": ObjectType[]}, any> | CallbackType<DynamoDB.BatchWriteItemInput, any>): void | Promise<DynamoDB.BatchWriteItemInput | {"unprocessedItems": ObjectType[]}> {
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "response"};
		}
		if (typeof settings === "undefined") {
			settings = {"return": "response"};
		}

		const prepareResponse = async (response: DynamoDB.BatchWriteItemOutput): Promise<{unprocessedItems: ObjectType[]}> => {
			const unprocessedArray = response.UnprocessedItems && response.UnprocessedItems[this[internalProperties].table()[internalProperties].name] ? response.UnprocessedItems[this[internalProperties].table()[internalProperties].name] : [];
			const tmpResultUnprocessed = await Promise.all(unprocessedArray.map((item) => this.Item.fromDynamo(item.PutRequest.Item)));
			return items.reduce((result: {unprocessedItems: ObjectType[]}, item) => {
				const unprocessedItem = tmpResultUnprocessed.find((searchItem) => Object.keys(item).every((keyProperty) => searchItem[keyProperty] === item[keyProperty]));
				if (unprocessedItem) {
					result.unprocessedItems.push(unprocessedItem);
				}
				return result;
			}, {"unprocessedItems": []}) as {unprocessedItems: ObjectType[]};
		};

		const paramsPromise: Promise<DynamoDB.BatchWriteItemInput> = (async (): Promise<DynamoDB.BatchWriteItemInput> => ({
			"RequestItems": {
				[this[internalProperties].table()[internalProperties].name]: await Promise.all(items.map(async (item) => ({
					"PutRequest": {
						"Item": await new this.Item(item as any).toDynamo({"defaults": true, "validate": true, "required": true, "enum": true, "forceDefault": true, "saveUnknown": true, "combine": true, "customTypesDynamo": true, "updateTimestamps": true, "modifiers": ["set"]})
					}
				})))
			}
		}))();
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.BatchWriteItemInput, any> = callback as CallbackType<DynamoDB.BatchWriteItemInput, any>;
				paramsPromise.then((result) => localCallback(null, result));
				return;
			} else {
				return paramsPromise;
			}
		}
		const promise = this[internalProperties].table()[internalProperties].pendingTaskPromise().then(() => paramsPromise).then((params) => ddb("batchWriteItem", params));

		if (callback) {
			const localCallback: CallbackType<{"unprocessedItems": ObjectType[]}, any> = callback as CallbackType<{"unprocessedItems": ObjectType[]}, any>;
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
	batchDelete (keys: InputKey[], callback: CallbackType<{unprocessedItems: ObjectType[]}, any>): void;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings & {"return": "request"}): DynamoDB.BatchWriteItemInput;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings & {"return": "request"}, callback: CallbackType<DynamoDB.BatchWriteItemInput, any>): void;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings): Promise<{unprocessedItems: ObjectType[]}>;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings, callback: CallbackType<{unprocessedItems: ObjectType[]}, any>): Promise<{unprocessedItems: ObjectType[]}>;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings & {"return": "response"}): Promise<{unprocessedItems: ObjectType[]}>;
	batchDelete (keys: InputKey[], settings: ModelBatchDeleteSettings & {"return": "response"}, callback: CallbackType<{unprocessedItems: ObjectType[]}, any>): Promise<{unprocessedItems: ObjectType[]}>;
	batchDelete (keys: InputKey[], settings?: ModelBatchDeleteSettings | CallbackType<{unprocessedItems: ObjectType[]}, any> | CallbackType<DynamoDB.BatchWriteItemInput, any>, callback?: CallbackType<{unprocessedItems: ObjectType[]}, any> | CallbackType<DynamoDB.BatchWriteItemInput, any>): void | DynamoDB.BatchWriteItemInput | Promise<{unprocessedItems: ObjectType[]}> {
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "response"};
		}
		if (typeof settings === "undefined") {
			settings = {"return": "response"};
		}

		const keyObjects: KeyObject[] = keys.map((key) => this[internalProperties].convertObjectToKey(key));

		const prepareResponse = async (response: DynamoDB.BatchWriteItemOutput): Promise<{unprocessedItems: ObjectType[]}> => {
			const unprocessedArray = response.UnprocessedItems && response.UnprocessedItems[this[internalProperties].table()[internalProperties].name] ? response.UnprocessedItems[this[internalProperties].table()[internalProperties].name] : [];
			const tmpResultUnprocessed = await Promise.all(unprocessedArray.map((item) => this.Item.fromDynamo(item.DeleteRequest.Key)));
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
				[this[internalProperties].table()[internalProperties].name]: keyObjects.map((key) => ({
					"DeleteRequest": {
						"Key": this.Item.objectToDynamo(key)
					}
				}))
			}
		};
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.BatchWriteItemInput, any> = callback as CallbackType<DynamoDB.BatchWriteItemInput, any>;
				localCallback(null, params);
				return;
			} else {
				return params;
			}
		}
		const promise = this[internalProperties].table()[internalProperties].pendingTaskPromise().then(() => ddb("batchWriteItem", params));

		if (callback) {
			const localCallback: CallbackType<{"unprocessedItems": ObjectType[]}, any> = callback as CallbackType<{"unprocessedItems": ObjectType[]}, any>;
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
	update (obj: Partial<T>, callback: CallbackType<T, any>): void;
	update (keyObj: ObjectType, updateObj: Partial<T>): Promise<T>;
	update (keyObj: ObjectType, updateObj: Partial<T>, callback: CallbackType<T, any>): void;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings & {"return": "request"}): Promise<DynamoDB.UpdateItemInput>;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings & {"return": "request"}, callback: CallbackType<DynamoDB.UpdateItemInput, any>): void;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings): Promise<T>;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings, callback: CallbackType<T, any>): void;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings & {"return": "item"}): Promise<T>;
	update (keyObj: ObjectType, updateObj: Partial<T>, settings: ModelUpdateSettings & {"return": "item"}, callback: CallbackType<T, any>): void;
	update (keyObj: ObjectType, updateObj?: Partial<T> | CallbackType<T, any> | CallbackType<DynamoDB.UpdateItemInput, any>, settings?: ModelUpdateSettings | CallbackType<T, any> | CallbackType<DynamoDB.UpdateItemInput, any>, callback?: CallbackType<T, any> | CallbackType<DynamoDB.UpdateItemInput, any>): void | Promise<T> | Promise<DynamoDB.UpdateItemInput> {
		if (typeof updateObj === "function") {
			callback = updateObj as CallbackType<ItemCarrier | DynamoDB.UpdateItemInput, any>; // TODO: fix this, for some reason `updateObj` has a type of Function which is forcing us to type cast it
			updateObj = null;
			settings = {"return": "item"};
		}
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "item"};
		}
		if (!updateObj) {
			const hashKeyName = this[internalProperties].getHashKey();
			updateObj = keyObj as Partial<T>;
			keyObj = {
				[hashKeyName]: keyObj[hashKeyName]
			};
			delete updateObj[hashKeyName];

			const rangeKeyName = this[internalProperties].getRangeKey();
			if (rangeKeyName) {
				keyObj[rangeKeyName] = updateObj[rangeKeyName];
				delete updateObj[rangeKeyName];
			}
		}
		if (typeof settings === "undefined") {
			settings = {"return": "item"};
		}

		const schema: Schema = this[internalProperties].schemas[0]; // TODO: fix this to get correct schema
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
						subValue = (await this.Item.objectFromSchema({[subKey]: dynamoType === "L" && !Array.isArray(subValue) ? [subValue] : subValue}, this, {"type": "toDynamo", "customTypesDynamo": true, "saveUnknown": true, ...updateType.objectFromSchemaSettings} as any))[subKey];
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

				const itemFunctionSettings: ItemObjectFromSchemaSettings = {"updateTimestamps": {"updatedAt": true}, "customTypesDynamo": true, "type": "toDynamo"};
				const defaultObjectFromSchema = await this.Item.objectFromSchema(await this.Item.prepareForObjectFromSchema({}, this, itemFunctionSettings), this, itemFunctionSettings);
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

			returnObject.ExpressionAttributeValues = this.Item.objectToDynamo(returnObject.ExpressionAttributeValues);
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

		const itemify = (item): Promise<any> => new this.Item(item, {"type": "fromDynamo"}).conformToSchema({"customTypesDynamo": true, "checkExpiredItem": true, "type": "fromDynamo"});
		const localSettings: ModelUpdateSettings = settings;
		const updateItemParamsPromise: Promise<DynamoDB.UpdateItemInput> = this[internalProperties].table()[internalProperties].pendingTaskPromise().then(async () => ({
			"Key": this.Item.objectToDynamo(keyObj),
			"ReturnValues": "ALL_NEW",
			...utils.merge_objects.main({"combineMethod": "object_combine"})(localSettings.condition ? localSettings.condition.requestObject({"index": {"start": index, "set": (i): void => {
				index = i;
			}}, "conditionString": "ConditionExpression", "conditionStringType": "string"}) : {}, await getUpdateExpressionObject()),
			"TableName": this[internalProperties].table()[internalProperties].name
		}));
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.UpdateItemInput, any> = callback as CallbackType<DynamoDB.UpdateItemInput, any>;
				updateItemParamsPromise.then((params) => localCallback(null, params));
				return;
			} else {
				return updateItemParamsPromise;
			}
		}
		const promise = updateItemParamsPromise.then((params) => ddb("updateItem", params));

		if (callback) {
			promise.then((response) => response.Attributes ? itemify(response.Attributes) : undefined).then((response) => callback(null, response)).catch((error) => callback(error));
		} else {
			return (async (): Promise<any> => {
				const response = await promise;
				return response.Attributes ? await itemify(response.Attributes) : undefined;
			})();
		}
	}

	// Create
	create (item: Partial<T>): Promise<T>;
	create (item: Partial<T>, callback: CallbackType<T, any>): void;
	create (item: Partial<T>, settings: ItemSaveSettings & {return: "request"}): Promise<DynamoDB.PutItemInput>;
	create (item: Partial<T>, settings: ItemSaveSettings & {return: "request"}, callback: CallbackType<DynamoDB.PutItemInput, any>): void;
	create (item: Partial<T>, settings: ItemSaveSettings): Promise<T>;
	create (item: Partial<T>, settings: ItemSaveSettings, callback: CallbackType<T, any>): void;
	create (item: Partial<T>, settings: ItemSaveSettings & {return: "item"}): Promise<T>;
	create (item: Partial<T>, settings: ItemSaveSettings & {return: "item"}, callback: CallbackType<T, any>): void;
	create (item: Partial<T>, settings?: ItemSaveSettings | CallbackType<T, any> | CallbackType<DynamoDB.PutItemInput, any>, callback?: CallbackType<T, any> | CallbackType<DynamoDB.PutItemInput, any>): void | Promise<T> | Promise<DynamoDB.PutItemInput> {
		if (typeof settings === "function" && !callback) {
			callback = settings;
			settings = {};
		}

		return new this.Item(item as any).save({"overwrite": false, ...settings} as any, callback as any);
	}

	// Delete
	delete (key: InputKey): Promise<void>;
	delete (key: InputKey, callback: CallbackType<void, any>): void;
	delete (key: InputKey, settings: ModelDeleteSettings & {return: "request"}): DynamoDB.DeleteItemInput;
	delete (key: InputKey, settings: ModelDeleteSettings & {return: "request"}, callback: CallbackType<DynamoDB.DeleteItemInput, any>): void;
	delete (key: InputKey, settings: ModelDeleteSettings): Promise<void>;
	delete (key: InputKey, settings: ModelDeleteSettings, callback: CallbackType<void, any>): void;
	delete (key: InputKey, settings: ModelDeleteSettings & {return: null}): Promise<void>;
	delete (key: InputKey, settings: ModelDeleteSettings & {return: null}, callback: CallbackType<void, any>): void;
	delete (key: InputKey, settings?: ModelDeleteSettings | CallbackType<void, any> | CallbackType<DynamoDB.DeleteItemInput, any>, callback?: CallbackType<void, any> | CallbackType<DynamoDB.DeleteItemInput, any>): void | DynamoDB.DeleteItemInput | Promise<void> {
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
			"Key": this.Item.objectToDynamo(this[internalProperties].convertObjectToKey(key)),
			"TableName": this[internalProperties].table()[internalProperties].name
		};

		if (settings.condition) {
			deleteItemParams = {
				...deleteItemParams,
				...settings.condition.requestObject()
			};
		}

		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.DeleteItemInput, any> = callback as CallbackType<DynamoDB.DeleteItemInput, any>;
				localCallback(null, deleteItemParams);
				return;
			} else {
				return deleteItemParams;
			}
		}
		const promise = this[internalProperties].table()[internalProperties].pendingTaskPromise().then(() => ddb("deleteItem", deleteItemParams));

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
	get (key: InputKey, callback: CallbackType<T, any>): void;
	get (key: InputKey, settings: ModelGetSettings & {return: "request"}): DynamoDB.GetItemInput;
	get (key: InputKey, settings: ModelGetSettings & {return: "request"}, callback: CallbackType<DynamoDB.GetItemInput, any>): void;
	get (key: InputKey, settings: ModelGetSettings): Promise<T>;
	get (key: InputKey, settings: ModelGetSettings, callback: CallbackType<T, any>): void;
	get (key: InputKey, settings: ModelGetSettings & {return: "item"}): Promise<T>;
	get (key: InputKey, settings: ModelGetSettings & {return: "item"}, callback: CallbackType<T, any>): void;
	get (key: InputKey, settings?: ModelGetSettings | CallbackType<T, any> | CallbackType<DynamoDB.GetItemInput, any>, callback?: CallbackType<T, any> | CallbackType<DynamoDB.GetItemInput, any>): void | DynamoDB.GetItemInput | Promise<T> {
		if (typeof settings === "function") {
			callback = settings;
			settings = {"return": "item"};
		}
		if (typeof settings === "undefined") {
			settings = {"return": "item"};
		}

		const conformToSchemaSettings: ItemObjectFromSchemaSettings = {"customTypesDynamo": true, "checkExpiredItem": true, "saveUnknown": true, "modifiers": ["get"], "type": "fromDynamo"};
		const itemify = (item: AttributeMap): Promise<ItemCarrier> => new this.Item(item as any, {"type": "fromDynamo"}).conformToSchema(conformToSchemaSettings);

		const getItemParams: DynamoDB.GetItemInput = {
			"Key": this.Item.objectToDynamo(this[internalProperties].convertObjectToKey(key)),
			"TableName": this[internalProperties].table()[internalProperties].name
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
				const localCallback: CallbackType<DynamoDB.GetItemInput, any> = callback as CallbackType<DynamoDB.GetItemInput, any>;
				localCallback(null, getItemParams);
				return;
			} else {
				return getItemParams;
			}
		}
		const promise = this[internalProperties].table()[internalProperties].pendingTaskPromise().then(() => ddb("getItem", getItemParams));

		if (callback) {
			const localCallback: CallbackType<ItemCarrier, any> = callback as CallbackType<ItemCarrier, any>;
			promise.then((response) => response.Item ? itemify(response.Item) : undefined).then((response) => localCallback(null, response)).catch((error) => callback(error));
		} else {
			return (async (): Promise<any> => {
				const response = await promise;
				return response.Item ? await itemify(response.Item) : undefined;
			})();
		}
	}

	// Serialize Many
	serializeMany (itemsArray: ModelType<ItemCarrier>[] = [], nameOrOptions: SerializerOptions | string): any {
		return this.serializer._serializeMany(itemsArray, nameOrOptions);
	}
}


Model.prototype.scan = function (object?: ConditionInitalizer): Scan<ItemCarrier> {
	return new Scan(this, object);
};
Model.prototype.query = function (object?: ConditionInitalizer): Query<ItemCarrier> {
	return new Query(this, object);
};

// Methods
const customMethodFunctions = (type: "model" | "item"): {set: (name: string, fn: FunctionType) => void; delete: (name: string) => void} => {
	const entryPoint = (self: Model<ItemCarrier>): ItemCarrier | typeof ItemCarrier => type === "item" ? self.Item.prototype : self.Item;
	return {
		"set": function (name: string, fn): void {
			const self: Model<ItemCarrier> = this as any;
			if (!entryPoint(self)[name] || entryPoint(self)[name][Internal.General.internalProperties] && entryPoint(self)[name][Internal.General.internalProperties].type === "customMethod") {
				entryPoint(self)[name] = function (...args): Promise<any> {
					const bindObject = type === "item" ? this : self.Item;
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
			const self: Model<ItemCarrier> = this as any;
			if (entryPoint(self)[name] && entryPoint(self)[name][Internal.General.internalProperties] && entryPoint(self)[name][Internal.General.internalProperties].type === "customMethod") {
				entryPoint(self)[name] = undefined;
			}
		}
	};
};
Model.prototype.methods = {
	...customMethodFunctions("model"),
	"item": customMethodFunctions("item")
};
