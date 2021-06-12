import {CustomError} from "dynamoose-utils";
import {CallbackType, DeepPartial, InputKey, KeyObject, ObjectType} from "../General";
import Internal = require("../Internal");
const {internalProperties} = Internal.General;
import {Model} from "../Model";
import {custom as customDefaults, original as originalDefaults} from "./defaults";
import utils = require("../utils");
import DynamoDB = require("@aws-sdk/client-dynamodb");
import {IndexItem} from "../Schema";
import {Item as ItemCarrier} from "../Item";
import {createTable, createTableRequest, updateTable, updateTimeToLive, waitForActive} from "./utilities";

// This class represents a single DynamoDB table
export class Table {
	transaction: any;
	static defaults: TableOptions;
	name: string;

	constructor (name: string, models: Model[], options: TableOptionsOptional = {}) {
		// Check name arguement
		if (!name) {
			throw new CustomError.InvalidParameter("Name must be passed into table constructor.");
		}
		if (typeof name !== "string") {
			throw new CustomError.InvalidParameterType("Name passed into table constructor should be of type string.");
		}
		// Check model arguement
		if (!models) {
			throw new CustomError.InvalidParameter("Models must be passed into table constructor.");
		}
		if (!Array.isArray(models) || !models.every((model: any) => model.Model && model.Model instanceof Model) || models.length === 0) {
			throw new CustomError.InvalidParameterType("Models passed into table constructor should be an array of models.");
		}


		Object.defineProperty(this, internalProperties, {
			"configurable": false,
			"value": {}
		});

		this[internalProperties].options = utils.combine_objects(options, customDefaults.get(), originalDefaults) as TableOptions;
		this[internalProperties].name = `${this[internalProperties].options.prefix}${name}${this[internalProperties].options.suffix}`;
		this[internalProperties].originalName = name; // This represents the name before prefix and suffix were added

		Object.defineProperty(this, "name", {
			"configurable": false,
			"value": this[internalProperties].name
		});

		// Methods
		this[internalProperties].getIndexes = async (): Promise<{GlobalSecondaryIndexes?: IndexItem[]; LocalSecondaryIndexes?: IndexItem[]}> => {
			return (await Promise.all(this[internalProperties].models.map((model) => model.Model[internalProperties].getIndexes(this)))).reduce((result, indexes) => {
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
		// This function returns the best matched model for the given object input
		this[internalProperties].modelForObject = async (object: ObjectType): Promise<Model<ItemCarrier>> => {
			const modelCorrectnessScores: number[] = this[internalProperties].models.map((model) => model.getTypePaths(object, {"type": "toDynamo", "includeAllProperties": true})).map((obj) => Object.values(obj).map((obj) => (obj as any)?.matchCorrectness || 0)).map((array) => Math.min(...array));
			const highestModelCorrectnessScoreIndex: number = modelCorrectnessScores.indexOf(Math.max(...modelCorrectnessScores));

			return this[internalProperties].models[highestModelCorrectnessScoreIndex];
		};
		this[internalProperties].getCreateTableAttributeParams = async (): Promise<Pick<DynamoDB.CreateTableInput, "AttributeDefinitions" | "KeySchema" | "GlobalSecondaryIndexes" | "LocalSecondaryIndexes">> => {
			// TODO: implement this
			return this[internalProperties].models[0].Model[internalProperties].getCreateTableAttributeParams(this);
		};
		this[internalProperties].getHashKey = (): string => {
			return this[internalProperties].models[0].getHashKey();
		};
		this[internalProperties].getRangeKey = (): string | void => {
			return this[internalProperties].models[0].getRangeKey();
		};

		if (!utils.all_elements_match(models.map((model: any) => model.Model[internalProperties].getHashKey()))) {
			throw new CustomError.InvalidParameter("hashKey's for all models's must match.");
		}
		if (!utils.all_elements_match(models.map((model: any) => model.Model[internalProperties].getRangeKey()).filter((key) => Boolean(key)))) {
			throw new CustomError.InvalidParameter("rangeKey's for all models's must match.");
		}
		if (options.expires) {
			if (typeof options.expires === "number") {
				options.expires = {
					"attribute": "ttl",
					"ttl": options.expires
				};
			}
			options.expires = utils.combine_objects(options.expires as any, {"attribute": "ttl"});

			models.flatMap((model: any) => model.Model[internalProperties].schemas).forEach((schema) => {
				schema[internalProperties].schemaObject[(options.expires as TableExpiresSettings).attribute] = {
					"type": {
						"value": Date,
						"settings": {
							"storage": "seconds"
						}
					},
					"default": (): Date => new Date(Date.now() + (options.expires as TableExpiresSettings).ttl)
				};
			});
		}
		this[internalProperties].models = models.map((model: any) => {
			if (model.Model[internalProperties]._table) {
				throw new CustomError.InvalidParameter(`Model ${model[internalProperties].name} has already been assigned to a table.`);
			}

			model.Model[internalProperties]._table = this;
			return model;
		});

		// Setup flow
		this[internalProperties].ready = false; // Represents if model is ready to be used for actions such as "get", "put", etc. This property being true does not guarantee anything on the DynamoDB server. It only guarantees that Dynamoose has finished the initalization steps required to allow the model to function as expected on the client side.
		this[internalProperties].alreadyCreated = false; // Represents if the table in DynamoDB was created prior to initalization. This will only be updated if `create` is true.
		this[internalProperties].pendingTasks = []; // Represents an array of promise resolver functions to be called when Model.ready gets set to true (at the end of the setup flow)
		this[internalProperties].latestTableDetails = null; // Stores the latest result from `describeTable` for the given table
		this[internalProperties].pendingTaskPromise = (): Promise<void> => { // Returns a promise that will be resolved after the Model is ready. This is used in all Model operations (Model.get, Item.save) to `await` at the beginning before running the AWS SDK method to ensure the Model is setup before running actions on it.
			return this[internalProperties].ready ? Promise.resolve() : new Promise((resolve) => {
				this[internalProperties].pendingTasks.push(resolve);
			});
		};
		const setupFlow = []; // An array of setup actions to be run in order
		// Create table
		if (this[internalProperties].options.create) {
			setupFlow.push(() => createTable(this));
		}
		// Wait for Active
		if ((this[internalProperties].options.waitForActive || {}).enabled) {
			setupFlow.push(() => waitForActive(this, false));
		}
		// Update Time To Live
		if ((this[internalProperties].options.create || (Array.isArray(this[internalProperties].options.update) ? this[internalProperties].options.update.includes(TableUpdateOptions.ttl) : this[internalProperties].options.update)) && options.expires) {
			setupFlow.push(() => updateTimeToLive(this));
		}
		// Update
		if (this[internalProperties].options.update && !this[internalProperties].alreadyCreated) {
			setupFlow.push(() => updateTable(this));
		}

		// Run setup flow
		const setupFlowPromise = setupFlow.reduce((existingFlow, flow) => {
			return existingFlow.then(() => flow()).then((flow) => {
				return typeof flow === "function" ? flow() : flow;
			});
		}, Promise.resolve());
		setupFlowPromise.then(() => this[internalProperties].ready = true).then(() => {
			this[internalProperties].pendingTasks.forEach((task) => task());
			this[internalProperties].pendingTasks = [];
		});

		// this.transaction = [
		// 	// `function` Default: `this[key]`
		// 	// `settingsIndex` Default: 1
		// 	// `dynamoKey` Default: utils.capitalize_first_letter(key)
		// 	{"key": "get"},
		// 	{"key": "create", "dynamoKey": "Put"},
		// 	{"key": "delete"},
		// 	{"key": "update", "settingsIndex": 2, "modifier": (response: DynamoDB.UpdateItemInput): DynamoDB.UpdateItemInput => {
		// 		delete response.ReturnValues;
		// 		return response;
		// 	}},
		// 	{"key": "condition", "settingsIndex": -1, "dynamoKey": "ConditionCheck", "function": (key: string, condition: Condition): DynamoDB.ConditionCheck => ({
		// 		"Key": this[internalProperties].models[0].Item.objectToDynamo(this[internalProperties].convertObjectToKey(key)),
		// 		"TableName": this[internalProperties].name,
		// 		...condition ? condition.requestObject() : {}
		// 	} as any)}
		// ].reduce((accumulator: ObjectType, currentValue) => {
		// 	const {key, modifier} = currentValue;
		// 	const dynamoKey = currentValue.dynamoKey || utils.capitalize_first_letter(key);
		// 	const settingsIndex = currentValue.settingsIndex || 1;
		// 	const func = currentValue.function || this[key].bind(this);

		// 	accumulator[key] = async (...args): Promise<DynamoDB.TransactWriteItem> => {
		// 		if (typeof args[args.length - 1] === "function") {
		// 			console.warn("Dynamoose Warning: Passing callback function into transaction method not allowed. Removing callback function from list of arguments.");
		// 			args.pop();
		// 		}

		// 		if (settingsIndex >= 0) {
		// 			args[settingsIndex] = utils.merge_objects({"return": "request"}, args[settingsIndex] || {});
		// 		}
		// 		let result = await func(...args);
		// 		if (modifier) {
		// 			result = modifier(result);
		// 		}
		// 		return {[dynamoKey]: result};
		// 	};

		// 	return accumulator;
		// }, {});
	}

	create (): Promise<void>
	create (callback: CallbackType<void, any>): void
	create (settings: TableCreateOptions): Promise<void>
	create (settings: TableCreateOptions, callback: CallbackType<void, any>): void
	create (settings: TableCreateOptions & {return: "request"}): Promise<DynamoDB.CreateTableInput>
	create (settings: TableCreateOptions & {return: "request"}, callback: CallbackType<DynamoDB.CreateTableInput, any>): void
	create (settings?: TableCreateOptions | CallbackType<void, any>, callback?: CallbackType<DynamoDB.CreateTableInput, any> | CallbackType<void, any>): void | Promise<DynamoDB.CreateTableInput | void> {
		if (typeof settings === "function") {
			callback = settings;
		}

		const promise = (settings as TableCreateOptions)?.return === "request" ? createTableRequest(this) : createTable(this, true);

		if (callback) {
			promise.then((response) => callback(null, response)).catch((error) => callback(error));
		} else {
			return promise;
		}
	}
}
Table.defaults = originalDefaults;


interface TableCreateOptions {
	return: "request" | undefined;
}

interface TableWaitForActiveSettings {
	enabled: boolean;
	check: {timeout: number; frequency: number};
}
export interface TableExpiresSettings {
	ttl: number;
	attribute: string;
	items?: {
		returnExpired: boolean;
	};
}
export enum TableUpdateOptions {
	ttl = "ttl",
	indexes = "indexes",
	throughput = "throughput"
}
export interface TableOptions {
	create: boolean;
	throughput: "ON_DEMAND" | number | {read: number; write: number};
	prefix: string;
	suffix: string;
	waitForActive: TableWaitForActiveSettings;
	update: boolean | TableUpdateOptions[];
	populate: string | string[] | boolean;
	expires: number | TableExpiresSettings;
}
export type TableOptionsOptional = DeepPartial<TableOptions>;
