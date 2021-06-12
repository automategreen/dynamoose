import ddb = require("./aws/ddb/internal");
import CustomError = require("./Error");
import utils = require("./utils");
import {Condition, ConditionInitalizer, BasicOperators, ConditionStorageTypeNested} from "./Condition";
import {Model} from "./Model";
import {Item} from "./Item";
import {CallbackType, ObjectType, ItemArray, SortOrder} from "./General";
import {PopulateItems} from "./Populate";
import Internal = require("./Internal");
const {internalProperties} = Internal.General;

enum ItemRetrieverTypes {
	scan = "scan",
	query = "query"
}
interface ItemRetrieverTypeInformation {
	type: ItemRetrieverTypes;
	pastTense: string;
}

// ItemRetriever is used for both Scan and Query since a lot of the code is shared between the two
// type ItemRetriever = BasicOperators;
abstract class ItemRetriever {
	internalSettings?: {
		model: Model<Item>;
		typeInformation: ItemRetrieverTypeInformation;
	};
	settings: {
		condition: Condition;
		limit?: number;
		all?: {delay: number; max: number};
		startAt?: any;
		attributes?: string[];
		index?: string;
		consistent?: boolean;
		count?: boolean;
		parallel?: number;
		sort?: SortOrder;
	};
	getRequest: (this: ItemRetriever) => Promise<any>;
	all: (this: ItemRetriever, delay?: number, max?: number) => ItemRetriever;
	limit: (this: ItemRetriever, value: number) => ItemRetriever;
	startAt: (this: ItemRetriever, value: ObjectType) => ItemRetriever;
	attributes: (this: ItemRetriever, value: string[]) => ItemRetriever;
	count: (this: ItemRetriever) => ItemRetriever;
	consistent: (this: ItemRetriever) => ItemRetriever;
	using: (this: ItemRetriever, value: string) => ItemRetriever;
	exec (this: ItemRetriever, callback?: any): any {
		let timesRequested = 0;
		const prepareForReturn = async (result): Promise<any> => {
			if (Array.isArray(result)) {
				result = utils.merge_objects(...result);
			}
			if (this.settings.count) {
				return {
					"count": result.Count,
					[`${this.internalSettings.typeInformation.pastTense}Count`]: result[`${utils.capitalize_first_letter(this.internalSettings.typeInformation.pastTense)}Count`]
				};
			}
			const array: any = (await Promise.all(result.Items.map(async (item) => await new this.internalSettings.model.Item(item, {"type": "fromDynamo"}).conformToSchema({"customTypesDynamo": true, "checkExpiredItem": true, "saveUnknown": true, "modifiers": ["get"], "type": "fromDynamo"})))).filter((a) => Boolean(a));
			array.lastKey = result.LastEvaluatedKey ? Array.isArray(result.LastEvaluatedKey) ? result.LastEvaluatedKey.map((key) => this.internalSettings.model.Item.fromDynamo(key)) : this.internalSettings.model.Item.fromDynamo(result.LastEvaluatedKey) : undefined;
			array.count = result.Count;
			array[`${this.internalSettings.typeInformation.pastTense}Count`] = result[`${utils.capitalize_first_letter(this.internalSettings.typeInformation.pastTense)}Count`];
			array[`times${utils.capitalize_first_letter(this.internalSettings.typeInformation.pastTense)}`] = timesRequested;
			array["populate"] = PopulateItems;
			array["toJSON"] = utils.dynamoose.itemToJSON;
			return array;
		};
		const promise = this.internalSettings.model[internalProperties].table()[internalProperties].pendingTaskPromise().then(() => this.getRequest()).then((request) => {
			const allRequest = (extraParameters = {}): any => {
				let promise: Promise<any> = ddb(this.internalSettings.typeInformation.type as any, {...request, ...extraParameters});
				timesRequested++;

				if (this.settings.all) {
					promise = promise.then(async (result) => {
						if (this.settings.all.delay && this.settings.all.delay > 0) {
							await utils.timeout(this.settings.all.delay);
						}

						let lastKey = result.LastEvaluatedKey;
						let requestedTimes = 1;
						while (lastKey && (this.settings.all.max === 0 || requestedTimes < this.settings.all.max)) {
							if (this.settings.all.delay && this.settings.all.delay > 0) {
								await utils.timeout(this.settings.all.delay);
							}

							const nextRequest: any = await ddb(this.internalSettings.typeInformation.type as any, {...request, ...extraParameters, "ExclusiveStartKey": lastKey});
							timesRequested++;
							result = utils.merge_objects(result, nextRequest);
							// The operation below is safe because right above we are overwriting the entire `result` variable, so there is no chance it'll be reassigned based on an outdated value since it's already been overwritten. There might be a better way to do this than ignoring the rule on the line below.
							result.LastEvaluatedKey = nextRequest.LastEvaluatedKey; // eslint-disable-line require-atomic-updates
							lastKey = nextRequest.LastEvaluatedKey;
							requestedTimes++;
						}

						return result;
					});
				}

				return promise;
			};

			if (this.settings.parallel) {
				return Promise.all(new Array(this.settings.parallel).fill(0).map((a, index) => allRequest({"Segment": index})));
			} else {
				return allRequest();
			}
		});

		// TODO: we do something similar to do this below in other functions as well (ex. get, save), where we allow a callback or a promise, we should figure out a way to make this code more DRY and have a standard way of doing this throughout Dynamoose
		if (callback) {
			promise.then((result) => prepareForReturn(result)).then((result) => callback(null, result)).catch((error) => callback(error));
		} else {
			return (async (): Promise<any> => {
				const result = await promise;
				const finalResult = await prepareForReturn(result);
				return finalResult;
			})();
		}
	}

	constructor (model: Model<Item>, typeInformation: ItemRetrieverTypeInformation, object?: ConditionInitalizer) {
		this.internalSettings = {model, typeInformation};

		let condition: Condition;
		try {
			condition = new Condition(object);
		} catch (e) {
			e.message = `${e.message.replace(" is invalid.", "")} is invalid for the ${this.internalSettings.typeInformation.type} operation.`;
			throw e;
		}

		this.settings = {
			"condition": condition
		};
	}
}
Object.entries(Condition.prototype).forEach((prototype) => {
	const [key, func] = prototype;
	if (key !== "requestObject") {
		ItemRetriever.prototype[key] = function (this: ItemRetriever, ...args): ItemRetriever {
			func.bind(this.settings.condition)(...args);
			return this;
		};
	}
});

ItemRetriever.prototype.getRequest = async function (this: ItemRetriever): Promise<any> {
	const object: any = {
		...this.settings.condition.requestObject({"conditionString": "FilterExpression", "conditionStringType": "array"}),
		"TableName": this.internalSettings.model[internalProperties].table()[internalProperties].name
	};

	if (this.settings.limit) {
		object.Limit = this.settings.limit;
	}
	if (this.settings.startAt) {
		object.ExclusiveStartKey = Item.isDynamoObject(this.settings.startAt) ? this.settings.startAt : this.internalSettings.model.Item.objectToDynamo(this.settings.startAt);
	}
	const indexes = await this.internalSettings.model[internalProperties].getIndexes();
	function canUseIndexOfTable (hashKeyOfTable, rangeKeyOfTable, chart: ConditionStorageTypeNested): boolean {
		const hashKeyInQuery = Object.entries(chart).find(([fieldName, {type}]) => type === "EQ" && fieldName === hashKeyOfTable);
		if (!hashKeyInQuery) {
			return false;
		}
		const isOneKeyQuery = Object.keys(chart).length === 1;
		if (isOneKeyQuery && hashKeyInQuery) {
			return true;
		} else if (rangeKeyOfTable) {
			return Object.entries(chart).some(([fieldName]) => fieldName !== hashKeyInQuery[0]);
		}
		return false;
	}
	if (this.settings.index) {
		object.IndexName = this.settings.index;
	} else if (this.internalSettings.typeInformation.type === "query") {
		const comparisonChart = this.settings.condition[internalProperties].settings.conditions.reduce((res, item) => {
			const myItem = Object.entries(item)[0];
			res[myItem[0]] = {"type": (myItem[1] as any).type};
			return res;
		}, {});
		if (!canUseIndexOfTable(this.internalSettings.model[internalProperties].getHashKey(), this.internalSettings.model[internalProperties].getRangeKey(), comparisonChart)) {
			const validIndexes = utils.array_flatten(Object.values(indexes))
				.map((index) => {
					const {hash, range} = index.KeySchema.reduce((res, item) => {
						res[item.KeyType.toLowerCase()] = item.AttributeName;
						return res;
					}, {});

					index._hashKey = hash;
					index._rangeKey = range;

					return index;
				})
				.filter((index) => comparisonChart[index._hashKey]?.type === "EQ");

			const index = validIndexes.find((index) => comparisonChart[index._rangeKey]) || validIndexes[0];

			if (!index) {
				throw new CustomError.InvalidParameter("Index can't be found for query.");
			} else {
				object.IndexName = index.IndexName;
			}
		}
	}
	function moveParameterNames (val, prefix): void {
		const entry = Object.entries(object.ExpressionAttributeNames).find((entry) => entry[1] === val);
		if (!entry) {
			return;
		}
		const [key, value] = entry;
		const filterExpressionIndex = object.FilterExpression.findIndex((item) => item.includes(key));
		const filterExpression = object.FilterExpression[filterExpressionIndex];
		if (filterExpression.includes("attribute_exists") || filterExpression.includes("contains")) {
			return;
		}
		object.ExpressionAttributeNames[`#${prefix}a`] = value;
		delete object.ExpressionAttributeNames[key];

		const valueKey = key.replace("#a", ":v");

		Object.keys(object.ExpressionAttributeValues).filter((key) => key.startsWith(valueKey)).forEach((key) => {
			object.ExpressionAttributeValues[key.replace(new RegExp(":v\\d"), `:${prefix}v`)] = object.ExpressionAttributeValues[key];
			delete object.ExpressionAttributeValues[key];
		});
		const newExpression = filterExpression.replace(key, `#${prefix}a`).replace(new RegExp(valueKey, "g"), `:${prefix}v`);

		object.KeyConditionExpression = `${object.KeyConditionExpression || ""}${object.KeyConditionExpression ? " AND " : ""}${newExpression}`;
		utils.object.delete(object.FilterExpression, filterExpressionIndex);
		const previousElementIndex = filterExpressionIndex === 0 ? 0 : filterExpressionIndex - 1;
		if (object.FilterExpression[previousElementIndex] === "AND") {
			utils.object.delete(object.FilterExpression, previousElementIndex);
		}
	}
	if (this.internalSettings.typeInformation.type === "query") {
		const index = utils.array_flatten(Object.values(indexes)).find((index) => index.IndexName === object.IndexName);
		if (index) {
			const {hash, range} = index.KeySchema.reduce((res, item) => {
				res[item.KeyType.toLowerCase()] = item.AttributeName;
				return res;
			}, {});

			moveParameterNames(hash, "qh");
			if (range) {
				moveParameterNames(range, "qr");
			}
		} else {
			moveParameterNames(this.internalSettings.model[internalProperties].getHashKey(), "qh");
			if (this.internalSettings.model[internalProperties].getRangeKey()) {
				moveParameterNames(this.internalSettings.model[internalProperties].getRangeKey(), "qr");
			}
		}
	}
	if (this.settings.consistent) {
		object.ConsistentRead = this.settings.consistent;
	}
	if (this.settings.count) {
		object.Select = "COUNT";
	}
	if (this.settings.parallel) {
		object.TotalSegments = this.settings.parallel;
	}
	if (this.settings.sort === SortOrder.descending) {
		object.ScanIndexForward = false;
	}
	if (this.settings.attributes) {
		if (!object.ExpressionAttributeNames) {
			object.ExpressionAttributeNames = {};
		}

		object.ProjectionExpression = this.settings.attributes.map((attribute) => {
			let expressionAttributeName = "";

			expressionAttributeName = (Object.entries(object.ExpressionAttributeNames).find((entry) => entry[1] === attribute) || [])[0];
			if (!expressionAttributeName) {
				const nextIndex = (Object.keys(object.ExpressionAttributeNames).map((item) => parseInt(item.replace("#a", ""))).filter((item) => !isNaN(item)).reduce((existing, item) => Math.max(item, existing), 0) || 0) + 1;
				expressionAttributeName = `#a${nextIndex}`;
				object.ExpressionAttributeNames[expressionAttributeName] = attribute;
			}

			return expressionAttributeName;
		}).sort().join(", ");
	}

	if (object.FilterExpression) {
		object.FilterExpression = utils.dynamoose.convertConditionArrayRequestObjectToString(object.FilterExpression);
	}
	if (object.FilterExpression === "") {
		delete object.FilterExpression;
	}

	return object;
};
interface ItemRetrieverResponse<T> extends ItemArray<T> {
	lastKey?: ObjectType;
	count: number;
}
export interface ScanResponse<T> extends ItemRetrieverResponse<T> {
	scannedCount: number;
	timesScanned: number;
}
export interface QueryResponse<T> extends ItemRetrieverResponse<T> {
	queriedCount: number;
	timesQueried: number;
}
interface SettingDefinition {
	name: string;
	only?: string[];
	boolean?: boolean;
	settingsName?: string;
}
const settings: (SettingDefinition | string)[] = [
	"limit",
	"startAt",
	"attributes",
	{"name": "count", "boolean": true},
	{"name": "consistent", "boolean": true},
	{"name": "using", "settingsName": "index"}
];
settings.forEach((item) => {
	ItemRetriever.prototype[(item as SettingDefinition).name || (item as string)] = function (value): ItemRetriever {
		const key: string = (item as SettingDefinition).settingsName || (item as SettingDefinition).name || (item as string);
		this.settings[key] = (item as SettingDefinition).boolean ? !this.settings[key] : value;
		return this;
	};
});
ItemRetriever.prototype.all = function (this: ItemRetriever, delay = 0, max = 0): ItemRetriever {
	this.settings.all = {delay, max};
	return this;
};

export interface Scan<T> extends ItemRetriever, BasicOperators<Scan<T>> {
	exec(): Promise<ScanResponse<T>>;
	exec(callback: CallbackType<ScanResponse<T>, any>): void;
}

export class Scan<T> extends ItemRetriever {
	exec (callback?: CallbackType<ScanResponse<T>, any>): Promise<ScanResponse<T>> | void {
		return super.exec(callback);
	}

	parallel (value: number): Scan<T> {
		this.settings.parallel = value;
		return this;
	}

	constructor (model: Model<Item>, object?: ConditionInitalizer) {
		super(model, {"type": ItemRetrieverTypes.scan, "pastTense": "scanned"}, object);
	}
}

export interface Query<T> extends ItemRetriever, BasicOperators<Query<T>> {
	exec(): Promise<QueryResponse<T>>;
	exec(callback: CallbackType<QueryResponse<T>, any>): void;
}

export class Query<T> extends ItemRetriever {
	exec (callback?: CallbackType<QueryResponse<T>, any>): Promise<QueryResponse<T>> | void {
		return super.exec(callback);
	}

	sort (order: SortOrder): Query<T> {
		this.settings.sort = order;
		return this;
	}

	constructor (model: Model<Item>, object?: ConditionInitalizer) {
		super(model, {"type": ItemRetrieverTypes.query, "pastTense": "queried"}, object);
	}
}
