import aws = require("./aws");
import ddb = require("./aws/ddb/internal");
import utils = require("./utils");
import Error = require("./Error");
import Internal = require("./Internal");
import {Model} from "./Model";
import {DynamoDBTypeResult, Schema, DynamoDBSetTypeResult, TimestampObject} from "./Schema";
const {internalProperties} = Internal.General;
const dynamooseUndefined = Internal.Public.undefined;

import {AttributeMap} from "./Types";
import DynamoDB = require("@aws-sdk/client-dynamodb");
import {ValueType} from "./Schema";
import {CallbackType, ObjectType} from "./General";
import {SerializerOptions} from "./Serializer";
import {PopulateItem, PopulateSettings} from "./Populate";
import {Condition} from "./Condition";
import {TableExpiresSettings} from "./Table";

export interface ItemSaveSettings {
	overwrite?: boolean;
	return?: "request" | "Item";
	condition?: Condition;
}
export interface ItemSettings {
	type?: "fromDynamo" | "toDynamo";
}

// Item represents an item in a Model that is either pending (not saved) or saved
export class Item {
	constructor (model: Model<Item>, object?: AttributeMap | ObjectType, settings?: ItemSettings) {
		const itemObject = Item.isDynamoObject(object) ? aws.converter().unmarshall(object) : object;
		Object.keys(itemObject).forEach((key) => this[key] = itemObject[key]);
		Object.defineProperty(this, internalProperties, {
			"configurable": false,
			"value": {}
		});
		this[internalProperties].originalObject = JSON.parse(JSON.stringify(itemObject));
		this[internalProperties].originalSettings = {...settings};

		Object.defineProperty(this, "model", {
			"configurable": false,
			"value": model
		});

		if (settings.type === "fromDynamo") {
			this[internalProperties].storedInDynamo = true;
		}
	}

	// Internal
	model?: Model<Item>;
	static objectToDynamo (object: ObjectType): AttributeMap;
	static objectToDynamo (object: any, settings: {type: "value"}): DynamoDB.AttributeValue;
	static objectToDynamo (object: ObjectType, settings: {type: "object"}): AttributeMap;
	static objectToDynamo (object: any, settings: {type: "object" | "value"} = {"type": "object"}): DynamoDB.AttributeValue | AttributeMap {
		if (object === undefined) {
			return undefined;
		}

		const options = settings.type === "value" ? undefined : {"removeUndefinedValues": true};
		return (settings.type === "value" ? aws.converter().convertToAttr : aws.converter().marshall)(object, options as any);
	}
	static fromDynamo (object: AttributeMap): ObjectType {
		return aws.converter().unmarshall(object);
	}
	// This function will return null if it's unknown if it is a Dynamo object (ex. empty object). It will return true if it is a Dynamo object and false if it's not.
	static isDynamoObject (object: ObjectType, recurrsive?: boolean): boolean | null {
		function isValid (value): boolean {
			if (typeof value === "undefined" || value === null) {
				return false;
			}
			const keys = Object.keys(value);
			const key = keys[0];
			const nestedResult = typeof value[key] === "object" && !(value[key] instanceof Buffer) ? Array.isArray(value[key]) ? value[key].every((value) => Item.isDynamoObject(value, true)) : Item.isDynamoObject(value[key]) : true;
			const {Schema} = require("./Schema");
			const attributeType = Schema.attributeTypes.findDynamoDBType(key);
			return typeof value === "object" && keys.length === 1 && attributeType && (nestedResult || Object.keys(value[key]).length === 0 || attributeType.isSet);
		}

		const keys = Object.keys(object);
		const values = Object.values(object);
		if (keys.length === 0) {
			return null;
		} else {
			return recurrsive ? isValid(object) : values.every((value) => isValid(value));
		}
	}

	static attributesWithSchema: (item: Item, model: Model<Item>) => Promise<string[]>;
	static objectFromSchema: (object: any, model: Model<Item>, settings?: ItemObjectFromSchemaSettings) => Promise<any>;
	static prepareForObjectFromSchema: (object: any, model: Model<Item>, settings: ItemObjectFromSchemaSettings) => any;
	conformToSchema: (this: Item, settings?: ItemObjectFromSchemaSettings) => Promise<Item>;
	toDynamo: (this: Item, settings?: Partial<ItemObjectFromSchemaSettings>) => Promise<any>;

	// This function handles actions that should take place before every response (get, scan, query, batchGet, etc.)
	async prepareForResponse (): Promise<Item> {
		if (this.model[internalProperties].table()[internalProperties].options.populate) {
			return this.populate({"properties": this.model[internalProperties].table()[internalProperties].options.populate});
		}
		return this;
	}

	// Original
	original (): ObjectType | null {
		return this[internalProperties].originalSettings.type === "fromDynamo" ? this[internalProperties].originalObject : null;
	}

	// toJSON
	toJSON (): ObjectType {
		return utils.dynamoose.itemToJSON.bind(this)();
	}

	// Serializer
	serialize (nameOrOptions?: SerializerOptions | string): ObjectType {
		return this.model.serializer._serialize(this, nameOrOptions);
	}

	// Delete
	delete (this: Item): Promise<void>;
	delete (this: Item, callback: CallbackType<void, any>): void;
	delete (this: Item, callback?: CallbackType<void, any>): Promise<void> | void {
		const hashKey = this.model[internalProperties].getHashKey();
		const rangeKey = this.model[internalProperties].getRangeKey();

		const key = {[hashKey]: this[hashKey]};
		if (rangeKey) {
			key[rangeKey] = this[rangeKey];
		}

		return this.model.delete(key, callback);
	}

	// Save
	save (this: Item): Promise<Item>;
	save (this: Item, callback: CallbackType<Item, any>): void;
	save (this: Item, settings: ItemSaveSettings & {return: "request"}): Promise<DynamoDB.PutItemInput>;
	save (this: Item, settings: ItemSaveSettings & {return: "request"}, callback: CallbackType<DynamoDB.PutItemInput, any>): void;
	save (this: Item, settings: ItemSaveSettings & {return: "item"}): Promise<Item>;
	save (this: Item, settings: ItemSaveSettings & {return: "item"}, callback: CallbackType<Item, any>): void;
	save (this: Item, settings?: ItemSaveSettings | CallbackType<Item, any> | CallbackType<DynamoDB.PutItemInput, any>, callback?: CallbackType<Item, any> | CallbackType<DynamoDB.PutItemInput, any>): void | Promise<Item | DynamoDB.PutItemInput> {
		if (typeof settings !== "object" && typeof settings !== "undefined") {
			callback = settings;
			settings = {};
		}
		if (typeof settings === "undefined") {
			settings = {};
		}

		let savedItem;

		const localSettings: ItemSaveSettings = settings;
		const paramsPromise = this.toDynamo({"defaults": true, "validate": true, "required": true, "enum": true, "forceDefault": true, "combine": true, "saveUnknown": true, "customTypesDynamo": true, "updateTimestamps": true, "modifiers": ["set"]}).then((item) => {
			savedItem = item;
			let putItemObj: DynamoDB.PutItemInput = {
				"Item": item,
				"TableName": this.model[internalProperties].table()[internalProperties].name
			};

			if (localSettings.condition) {
				putItemObj = {
					...putItemObj,
					...localSettings.condition.requestObject()
				};
			}

			if (localSettings.overwrite === false) {
				const conditionExpression = "attribute_not_exists(#__hash_key)";
				putItemObj.ConditionExpression = putItemObj.ConditionExpression ? `(${putItemObj.ConditionExpression}) AND (${conditionExpression})` : conditionExpression;
				putItemObj.ExpressionAttributeNames = {
					...putItemObj.ExpressionAttributeNames || {},
					"#__hash_key": this.model[internalProperties].getHashKey()
				};
			}

			return putItemObj;
		});
		if (settings.return === "request") {
			if (callback) {
				const localCallback: CallbackType<DynamoDB.PutItemInput, any> = callback as CallbackType<DynamoDB.PutItemInput, any>;
				paramsPromise.then((result) => localCallback(null, result));
				return;
			} else {
				return paramsPromise;
			}
		}
		const promise: Promise<DynamoDB.PutItemOutput> = Promise.all([paramsPromise, this.model[internalProperties].table()[internalProperties].pendingTaskPromise()]).then((promises) => {
			const [putItemObj] = promises;
			return ddb("putItem", putItemObj);
		});

		if (callback) {
			const localCallback: CallbackType<Item, any> = callback as CallbackType<Item, any>;
			promise.then(() => {
				this[internalProperties].storedInDynamo = true;

				const returnItem = new this.model.Item(savedItem as any);
				returnItem[internalProperties].storedInDynamo = true;

				localCallback(null, returnItem);
			}).catch((error) => callback(error));
		} else {
			return (async (): Promise<Item> => {
				await promise;
				this[internalProperties].storedInDynamo = true;

				const returnItem = new this.model.Item(savedItem as any);
				returnItem[internalProperties].storedInDynamo = true;

				return returnItem;
			})();
		}
	}

	// Populate
	populate (): Promise<Item>;
	populate (callback: CallbackType<Item, any>): void;
	populate (settings: PopulateSettings): Promise<Item>;
	populate (settings: PopulateSettings, callback: CallbackType<Item, any>): void;
	populate (...args): Promise<Item> | void {
		return PopulateItem.bind(this)(...args);
	}
}

export class AnyItem extends Item {
	[key: string]: any;
}

// This function will mutate the object passed in to run any actions to conform to the schema that cannot be achieved through non mutating methods in Item.objectFromSchema (setting timestamps, etc.)
Item.prepareForObjectFromSchema = async function<T>(object: T, model: Model<Item>, settings: ItemObjectFromSchemaSettings): Promise<T> {
	if (settings.updateTimestamps) {
		const schema: Schema = await model[internalProperties].schemaForObject(object);
		if (schema[internalProperties].settings.timestamps && settings.type === "toDynamo") {
			const date = new Date();

			const createdAtProperties: string[] = ((Array.isArray((schema[internalProperties].settings.timestamps as TimestampObject).createdAt) ? (schema[internalProperties].settings.timestamps as TimestampObject).createdAt : [(schema[internalProperties].settings.timestamps as TimestampObject).createdAt]) as any).filter((a) => Boolean(a));
			const updatedAtProperties: string[] = ((Array.isArray((schema[internalProperties].settings.timestamps as TimestampObject).updatedAt) ? (schema[internalProperties].settings.timestamps as TimestampObject).updatedAt : [(schema[internalProperties].settings.timestamps as TimestampObject).updatedAt]) as any).filter((a) => Boolean(a));
			if (object[internalProperties] && !object[internalProperties].storedInDynamo && (typeof settings.updateTimestamps === "boolean" || settings.updateTimestamps.createdAt)) {
				createdAtProperties.forEach((prop) => {
					utils.object.set(object as any, prop, date);
				});
			}
			if (typeof settings.updateTimestamps === "boolean" || settings.updateTimestamps.updatedAt) {
				updatedAtProperties.forEach((prop) => {
					utils.object.set(object as any, prop, date);
				});
			}
		}
	}
	return object;
};
// This function will return a list of attributes combining both the schema attributes with the item attributes. This also takes into account all attributes that could exist (ex. properties in sets that don't exist in item), adding the indexes for each item in the item set.
// https://stackoverflow.com/a/59928314/894067
const attributesWithSchemaCache: ObjectType = {};
Item.attributesWithSchema = async function (item: Item, model: Model<Item>): Promise<string[]> {
	const schema: Schema = await model[internalProperties].schemaForObject(item);
	const attributes = schema.attributes();
	const itemID = utils.object.keys(item as any).join("");
	if (attributesWithSchemaCache[itemID] && attributesWithSchemaCache[itemID][attributes.join()]) {
		return attributesWithSchemaCache[itemID][attributes.join()];
	}
	// build a tree out of schema attributes
	const root = {};
	attributes.forEach((attribute) => {
		let node = root;
		attribute.split(".").forEach((part) => {
			node[part] = node[part] || {};
			node = node[part];
		});
	});
	// explore the tree
	function traverse (node, treeNode, outPath, callback): void {
		callback(outPath);
		if (Object.keys(treeNode).length === 0) { // a leaf
			return;
		}

		Object.keys(treeNode).forEach((attr) => {
			if (attr === "0") {
				// We check for empty objects here (added `typeof node === "object" && Object.keys(node).length == 0`, see PR https://github.com/dynamoose/dynamoose/pull/1034) to handle the use case of 2d arrays, or arrays within arrays. `node` in that case will be an empty object.
				if (!node || node.length == 0 || typeof node === "object" && Object.keys(node).length == 0) {
					node = [{}]; // fake the path for arrays
				}
				node.forEach((a, index) => {
					outPath.push(index);
					traverse(node[index], treeNode[attr], outPath, callback);
					outPath.pop();
				});
			} else {
				if (!node) {
					node = {}; // fake the path for properties
				}
				outPath.push(attr);
				traverse(node[attr], treeNode[attr], outPath, callback);
				outPath.pop();
			}
		});
	}
	const out = [];
	traverse(item, root, [], (val) => out.push(val.join(".")));
	const result = out.slice(1);
	attributesWithSchemaCache[itemID] = {[attributes.join()]: result};
	return result;
};
export interface ItemObjectFromSchemaSettings {
	type: "toDynamo" | "fromDynamo";
	schema?: Schema;
	checkExpiredItem?: boolean;
	saveUnknown?: boolean;
	defaults?: boolean;
	forceDefault?: boolean;
	customTypesDynamo?: boolean;
	validate?: boolean;
	required?: boolean | "nested";
	enum?: boolean;
	populate?: boolean;
	combine?: boolean;
	modifiers?: ("set" | "get")[];
	updateTimestamps?: boolean | {updatedAt?: boolean; createdAt?: boolean};
}
// This function will return an object that conforms to the schema (removing any properties that don't exist, using default values, etc.) & throws an error if there is a typemismatch.
Item.objectFromSchema = async function (object: any, model: Model<Item>, settings: ItemObjectFromSchemaSettings = {"type": "toDynamo"}): Promise<ObjectType> {
	if (settings.checkExpiredItem && model[internalProperties].table()[internalProperties].options.expires && ((model[internalProperties].table()[internalProperties].options.expires as TableExpiresSettings).items || {}).returnExpired === false && object[(model[internalProperties].table()[internalProperties].options.expires as TableExpiresSettings).attribute] && object[(model[internalProperties].table()[internalProperties].options.expires as TableExpiresSettings).attribute] * 1000 < Date.now()) {
		return undefined;
	}

	const returnObject = {...object};
	const schema: Schema = settings.schema || await model[internalProperties].schemaForObject(returnObject);
	const schemaAttributes = schema.attributes(returnObject);

	// Type check
	const validParents = []; // This array is used to allow for set contents to not be type checked
	const keysToDelete = [];
	const typeIndexOptionMap = schema.getTypePaths(returnObject, settings);
	const checkTypeFunction = (item): void => {
		const [key, value] = item;
		if (validParents.find((parent) => key.startsWith(parent.key) && (parent.infinite || key.split(".").length === parent.key.split(".").length + 1))) {
			return;
		}
		const genericKey = key.replace(/\.\d+/gu, ".0"); // This is a key replacing all list numbers with 0 to standardize things like checking if it exists in the schema
		const existsInSchema = schemaAttributes.includes(genericKey);
		if (existsInSchema) {
			const {isValidType, matchedTypeDetails, typeDetailsArray} = utils.dynamoose.getValueTypeCheckResult(schema, value, genericKey, settings, {"standardKey": true, typeIndexOptionMap});
			if (!isValidType) {
				throw new Error.TypeMismatch(`Expected ${key} to be of type ${typeDetailsArray.map((detail) => detail.dynamicName ? detail.dynamicName() : detail.name.toLowerCase()).join(", ")}, instead found type ${utils.type_name(value, typeDetailsArray)}.`);
			} else if (matchedTypeDetails.isSet || matchedTypeDetails.name.toLowerCase() === "model") {
				validParents.push({key, "infinite": true});
			} else if (/*typeDetails.dynamodbType === "M" || */matchedTypeDetails.dynamodbType === "L") {
				// The code below is an optimization for large array types to speed up the process of not having to check the type for every element but only the ones that are different
				value.forEach((subValue, index: number, array: any[]) => {
					if (index === 0 || typeof subValue !== typeof array[0]) {
						checkTypeFunction([`${key}.${index}`, subValue]);
					} else if (keysToDelete.includes(`${key}.0`) && typeof subValue === typeof array[0]) {
						keysToDelete.push(`${key}.${index}`);
					}
				});
				validParents.push({key});
			}
		} else {
			// Check saveUnknown
			if (!settings.saveUnknown || !utils.dynamoose.wildcard_allowed_check(schema.getSettingValue("saveUnknown"), key)) {
				keysToDelete.push(key);
			}
		}
	};
	utils.object.entries(returnObject).filter((item) => item[1] !== undefined && item[1] !== dynamooseUndefined).map(checkTypeFunction);
	keysToDelete.reverse().forEach((key) => utils.object.delete(returnObject, key));

	if (settings.defaults || settings.forceDefault) {
		await Promise.all((await Item.attributesWithSchema(returnObject, model)).map(async (key) => {
			const value = utils.object.get(returnObject, key);
			if (value === dynamooseUndefined) {
				utils.object.set(returnObject, key, undefined);
			} else {
				const defaultValue = await schema.defaultCheck(key, value as ValueType, settings);
				const isDefaultValueUndefined = Array.isArray(defaultValue) ? defaultValue.some((defaultValue) => typeof defaultValue === "undefined" || defaultValue === null) : typeof defaultValue === "undefined" || defaultValue === null;
				if (!isDefaultValueUndefined) {
					const {isValidType, typeDetailsArray} = utils.dynamoose.getValueTypeCheckResult(schema, defaultValue, key, settings, {typeIndexOptionMap});
					if (!isValidType) {
						throw new Error.TypeMismatch(`Expected ${key} to be of type ${typeDetailsArray.map((detail) => detail.dynamicName ? detail.dynamicName() : detail.name.toLowerCase()).join(", ")}, instead found type ${typeof defaultValue}.`);
					} else {
						utils.object.set(returnObject, key, defaultValue);
					}
				}
			}
		}));
	}
	// Custom Types
	if (settings.customTypesDynamo) {
		(await Item.attributesWithSchema(returnObject, model)).map((key) => {
			const value = utils.object.get(returnObject, key);
			const isValueUndefined = typeof value === "undefined" || value === null;
			if (!isValueUndefined) {
				const typeDetails = utils.dynamoose.getValueTypeCheckResult(schema, value, key, settings, {typeIndexOptionMap}).matchedTypeDetails as DynamoDBTypeResult;
				const {customType} = typeDetails;
				const {"type": typeInfo} = typeDetails.isOfType(value as ValueType);
				const isCorrectTypeAlready = typeInfo === (settings.type === "toDynamo" ? "underlying" : "main");
				if (customType && customType.functions[settings.type] && !isCorrectTypeAlready) {
					const customValue = customType.functions[settings.type](value);
					utils.object.set(returnObject, key, customValue);
				}
			}
		});
	}
	// DynamoDB Type Handler (ex. converting sets to correct value for toDynamo & fromDynamo)
	utils.object.entries(returnObject).filter((item) => typeof item[1] === "object").forEach((item) => {
		const [key, value] = item;
		let typeDetails;
		try {
			typeDetails = utils.dynamoose.getValueTypeCheckResult(schema, value, key, settings, {typeIndexOptionMap}).matchedTypeDetails;
		} catch (e) {
			const {Schema} = require("./Schema");
			typeDetails = Schema.attributeTypes.findTypeForValue(value, settings.type, settings);
		}

		if (typeDetails && typeDetails[settings.type]) {
			utils.object.set(returnObject, key, typeDetails[settings.type](value));
		}
	});
	if (settings.combine) {
		schemaAttributes.map((key) => {
			try {
				const typeDetails = schema.getAttributeTypeDetails(key);

				return {
					key,
					"type": typeDetails
				};
			} catch (e) {} // eslint-disable-line no-empty
		}).filter((item: any) => {
			return Array.isArray(item.type) ? item.type.some((type) => type.name === "Combine") : item.type.name === "Combine";
		}).map((obj: {"key": string; "type": DynamoDBTypeResult | DynamoDBSetTypeResult | DynamoDBTypeResult[] | DynamoDBSetTypeResult[]} | undefined): {"key": string; "type": DynamoDBTypeResult | DynamoDBSetTypeResult} => {
			if (obj && Array.isArray(obj.type)) {
				throw new Error.InvalidParameter("Combine type is not allowed to be used with multiple types.");
			}

			return obj as any;
		}).forEach((item) => {
			const {key, type} = item;

			const value = type.typeSettings.attributes.map((attribute) => utils.object.get(returnObject, attribute)).filter((value) => typeof value !== "undefined" && value !== null).join(type.typeSettings.seperator);
			utils.object.set(returnObject, key, value);
		});
	}
	if (settings.modifiers) {
		await Promise.all(settings.modifiers.map(async (modifier) => {
			return Promise.all((await Item.attributesWithSchema(returnObject, model)).map(async (key) => {
				const value = utils.object.get(returnObject, key);
				const modifierFunction = await schema.getAttributeSettingValue(modifier, key, {"returnFunction": true, typeIndexOptionMap});
				const modifierFunctionExists: boolean = Array.isArray(modifierFunction) ? modifierFunction.some((val) => Boolean(val)) : Boolean(modifierFunction);
				const isValueUndefined = typeof value === "undefined" || value === null;
				if (modifierFunctionExists && !isValueUndefined) {
					const oldValue = object.original ? utils.object.get(object.original(), key) : undefined;
					utils.object.set(returnObject, key, await modifierFunction(value, oldValue));
				}
			}));
		}));
	}
	if (settings.validate) {
		await Promise.all((await Item.attributesWithSchema(returnObject, model)).map(async (key) => {
			const value = utils.object.get(returnObject, key);
			const isValueUndefined = typeof value === "undefined" || value === null;
			if (!isValueUndefined) {
				const validator = await schema.getAttributeSettingValue("validate", key, {"returnFunction": true, typeIndexOptionMap});
				if (validator) {
					let result;
					if (validator instanceof RegExp) {
						// TODO: fix the line below to not use `as`. This will cause a weird issue even in vanilla JS, where if your validator is a Regular Expression but the type isn't a string, it will throw a super random error.
						result = validator.test(value as string);
					} else {
						result = typeof validator === "function" ? await validator(value) : validator === value;
					}

					if (!result) {
						throw new Error.ValidationError(`${key} with a value of ${value} had a validation error when trying to save the item`);
					}
				}
			}
		}));
	}
	if (settings.required) {
		let attributesToCheck = await Item.attributesWithSchema(returnObject, model);
		if (settings.required === "nested") {
			attributesToCheck = attributesToCheck.filter((attribute) => utils.object.keys(returnObject).find((key) => attribute.startsWith(key)));
		}
		await Promise.all(attributesToCheck.map(async (key) => {
			const check = async (): Promise<void> => {
				const value = utils.object.get(returnObject, key);
				await schema.requiredCheck(key, value as ValueType);
			};

			const keyParts = key.split(".");
			const parentKey = keyParts.slice(0, -1).join(".");
			if (parentKey) {
				const parentValue = utils.object.get(returnObject, parentKey);
				const isParentValueUndefined = typeof parentValue === "undefined" || parentValue === null;
				if (!isParentValueUndefined) {
					await check();
				}
			} else {
				await check();
			}
		}));
	}
	if (settings.enum) {
		await Promise.all((await Item.attributesWithSchema(returnObject, model)).map(async (key) => {
			const value = utils.object.get(returnObject, key);
			const isValueUndefined = typeof value === "undefined" || value === null;
			if (!isValueUndefined) {
				const enumArray = await schema.getAttributeSettingValue("enum", key, {"returnFunction": false, typeIndexOptionMap});
				if (enumArray && !enumArray.includes(value)) {
					throw new Error.ValidationError(`${key} must equal ${JSON.stringify(enumArray)}, but is set to ${value}`);
				}
			}
		}));
	}

	return returnObject;
};
Item.prototype.toDynamo = async function (this: Item, settings: Partial<ItemObjectFromSchemaSettings> = {}): Promise<any> {
	const newSettings: ItemObjectFromSchemaSettings = {
		...settings,
		"type": "toDynamo"
	};
	await Item.prepareForObjectFromSchema(this, this.model, newSettings);
	const object = await Item.objectFromSchema(this, this.model, newSettings);
	return Item.objectToDynamo(object);
};
// This function will modify the item to conform to the Schema
Item.prototype.conformToSchema = async function (this: Item, settings: ItemObjectFromSchemaSettings = {"type": "fromDynamo"}): Promise<Item> {
	let item = this;
	if (settings.type === "fromDynamo") {
		item = await this.prepareForResponse();
	}
	await Item.prepareForObjectFromSchema(item, item.model, settings);
	const expectedObject = await Item.objectFromSchema(item, item.model, settings);
	if (!expectedObject) {
		return expectedObject;
	}
	const expectedKeys = Object.keys(expectedObject);
	Object.keys(item).forEach((key) => {
		if (!expectedKeys.includes(key)) {
			delete this[key];
		} else if (this[key] !== expectedObject[key]) {
			this[key] = expectedObject[key];
		}
	});

	return this;
};
