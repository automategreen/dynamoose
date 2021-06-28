import CustomError = require("./Error");
import utils = require("./utils");
import Internal = require("./Internal");
import {Document, DocumentObjectFromSchemaSettings} from "./Document";
import {Model} from "./Model";
import {DynamoDB} from "aws-sdk";
import {ModelType, ObjectType} from "./General";

// TODO: the interfaces below are so similar, we should consider combining them into one. We also do a lot of `DynamoDBTypeResult | DynamoDBSetTypeResult` in the code base.
export interface DynamoDBSetTypeResult {
	name: string;
	dynamicName?: (() => string);
	dynamodbType: string; // TODO: This should probably be an enum
	isOfType: (value: ValueType, type?: "toDynamo" | "fromDynamo", settings?: Partial<DocumentObjectFromSchemaSettings>) => boolean;
	isSet: true;
	customType?: any;
	typeSettings?: AttributeDefinitionTypeSettings;

	toDynamo: (val: GeneralValueType[]) => SetValueType;
	fromDynamo: (val: SetValueType) => Set<ValueType>;
}
export interface DynamoDBTypeResult {
	name: string;
	dynamicName?: (() => string);
	dynamodbType: string | string[]; // TODO: This should probably be an enum
	isOfType: (value: ValueType) => {value: ValueType; type: string};
	isSet: false;
	customType?: any;
	typeSettings?: AttributeDefinitionTypeSettings;

	nestedType: boolean;
	set?: DynamoDBSetTypeResult;
}

interface DynamoDBTypeCreationObject {
	name: string;
	dynamicName?: ((typeSettings?: AttributeDefinitionTypeSettings) => string);
	dynamodbType: string | string[] | DynamoDBType | ((typeSettings: AttributeDefinitionTypeSettings) => string | string[]);
	set?: boolean | ((typeSettings?: AttributeDefinitionTypeSettings) => boolean);
	jsType: any;
	nestedType?: boolean;
	customType?: {functions: (typeSettings: AttributeDefinitionTypeSettings) => {toDynamo?: (val: ValueType) => ValueType; fromDynamo?: (val: ValueType) => ValueType; isOfType: (val: ValueType, type: "toDynamo" | "fromDynamo") => boolean}};
	customDynamoName?: string | ((typeSettings?: AttributeDefinitionTypeSettings) => string);
}

class DynamoDBType implements DynamoDBTypeCreationObject {
	// TODO: since the code below will always be the exact same as DynamoDBTypeCreationObject we should see if there is a way to make it more DRY and not repeat it
	name: string;
	dynamicName?: ((typeSettings?: AttributeDefinitionTypeSettings) => string);
	dynamodbType: string | string[] | DynamoDBType | ((typeSettings: AttributeDefinitionTypeSettings) => string | string[]);
	set?: boolean | ((typeSettings?: AttributeDefinitionTypeSettings) => boolean);
	jsType: any;
	nestedType?: boolean;
	customType?: {functions: (typeSettings?: AttributeDefinitionTypeSettings) => {toDynamo: (val: ValueType) => ValueType; fromDynamo: (val: ValueType) => ValueType; isOfType: (val: ValueType, type: "toDynamo" | "fromDynamo") => boolean}};
	customDynamoName?: string | ((typeSettings?: AttributeDefinitionTypeSettings) => string);

	constructor (obj: DynamoDBTypeCreationObject) {
		Object.keys(obj).forEach((key) => {
			this[key] = obj[key];
		});
	}

	result (typeSettings?: AttributeDefinitionTypeSettings): DynamoDBTypeResult {
		// Can't use variable below to check type, see TypeScript issue link below for more information
		// https://github.com/microsoft/TypeScript/issues/37855
		// const isSubType = this.dynamodbType instanceof DynamoDBType; // Represents underlying DynamoDB type for custom types
		const type = this.dynamodbType instanceof DynamoDBType ? this.dynamodbType : this;
		const dynamodbType: string | string[] = ((): string | string[] => {
			if (this.dynamodbType instanceof DynamoDBType) {
				return this.dynamodbType.dynamodbType as string;
			} else if (typeof this.dynamodbType === "function") {
				return this.dynamodbType(typeSettings);
			} else {
				return this.dynamodbType;
			}
		})();
		const result: DynamoDBTypeResult = {
			"name": this.name,
			dynamodbType,
			"nestedType": this.nestedType,
			"isOfType": this.jsType.func ? (val) => this.jsType.func(val, typeSettings) : (val): {value: ValueType; type: string} => {
				return [{"value": this.jsType, "type": "main"}, {"value": this.dynamodbType instanceof DynamoDBType ? type.jsType : null, "type": "underlying"}].filter((a) => Boolean(a.value)).find((jsType) => typeof jsType.value === "string" ? typeof val === jsType.value : val instanceof jsType.value);
			},
			"isSet": false,
			typeSettings
		};
		if (this.dynamicName) {
			result.dynamicName = (): string => this.dynamicName(typeSettings);
		}

		if (this.customType) {
			const functions = this.customType.functions(typeSettings);
			result.customType = {
				...this.customType,
				functions
			};
		}

		const isSetAllowed = typeof type.set === "function" ? type.set(typeSettings) : type.set;
		if (isSetAllowed) {
			let typeName;
			if (type.customDynamoName) {
				typeName = typeof type.customDynamoName === "function" ? type.customDynamoName(typeSettings) : type.customDynamoName;
			} else {
				typeName = type.name;
			}
			result.set = {
				"name": `${this.name} Set`,
				"isSet": true,
				"dynamodbType": `${dynamodbType}S`,
				"isOfType": (val: ValueType, type: "toDynamo" | "fromDynamo", settings: Partial<DocumentObjectFromSchemaSettings> = {}): boolean => {
					if (type === "toDynamo") {
						return !settings.saveUnknown && Array.isArray(val) && val.every((subValue) => result.isOfType(subValue)) || val instanceof Set && [...val].every((subValue) => result.isOfType(subValue));
					} else {
						const setVal = val as SetValueType; // TODO: Probably bad practice here, should figure out how to do this better.
						return setVal.wrapperName === "Set" && setVal.type === typeName && Array.isArray(setVal.values);
					}
				},
				"toDynamo": (val: GeneralValueType[]): SetValueType => ({"wrapperName": "Set", "type": typeName, "values": [...val]}),
				"fromDynamo": (val: SetValueType): Set<ValueType> => new Set(val.values),
				typeSettings
			};
			if (this.dynamicName) {
				result.set.dynamicName = (): string => `${this.dynamicName(typeSettings)} Set`;
			}
			if (this.customType) {
				result.set.customType = {
					"functions": {
						"toDynamo": (val: GeneralValueType[]): ValueType[] => val.map(result.customType.functions.toDynamo),
						"fromDynamo": (val: SetValueType): {values: ValueType} => ({...val, "values": val.values.map(result.customType.functions.fromDynamo)}),
						"isOfType": (val: ValueType, type: "toDynamo" | "fromDynamo"): boolean => {
							if (type === "toDynamo") {
								return Array.isArray(val) && val.every((item) => result.customType.functions.isOfType(item, type));
							} else {
								const setVal = val as SetValueType; // TODO: Probably bad practice here, should figure out how to do this better.
								return setVal.wrapperName === "Set" && setVal.type === typeName && Array.isArray(setVal.values);
							}
						}
					}
				};
			}
		}

		return result;
	}
}

const attributeTypesMain: DynamoDBType[] = ((): DynamoDBType[] => {
	const numberType = new DynamoDBType({"name": "Number", "dynamodbType": "N", "set": true, "jsType": "number"});
	const stringType = new DynamoDBType({"name": "String", "dynamodbType": "S", "set": true, "jsType": "string"});
	const booleanType = new DynamoDBType({"name": "Boolean", "dynamodbType": "BOOL", "jsType": "boolean"});
	return [
		new DynamoDBType({"name": "Null", "dynamodbType": "NULL", "set": false, "jsType": {"func": (val): boolean => val === null}}),
		new DynamoDBType({"name": "Buffer", "dynamodbType": "B", "set": true, "jsType": Buffer, "customDynamoName": "Binary"}),
		booleanType,
		new DynamoDBType({"name": "Array", "dynamodbType": "L", "jsType": {"func": Array.isArray}, "nestedType": true}),
		new DynamoDBType({"name": "Object", "dynamodbType": "M", "jsType": {"func": (val): boolean => Boolean(val) && val.constructor === Object && (val.wrapperName !== "Set" || Object.keys(val).length !== 3 || !val.type || !val.values)}, "nestedType": true}),
		numberType,
		stringType,
		new DynamoDBType({"name": "Date", "dynamodbType": numberType, "customType": {
			"functions": (typeSettings: AttributeDefinitionTypeSettings): {toDynamo: (val: Date) => number; fromDynamo: (val: number) => Date; isOfType: (val: Date, type: "toDynamo" | "fromDynamo") => boolean} => ({
				"toDynamo": (val: Date): number => {
					if (typeSettings.storage === "seconds") {
						return Math.round(val.getTime() / 1000);
					} else {
						return val.getTime();
					}
				},
				"fromDynamo": (val: number): Date => {
					if (typeSettings.storage === "seconds") {
						return new Date(val * 1000);
					} else {
						return new Date(val);
					}
				},
				"isOfType": (val: Date, type: "toDynamo" | "fromDynamo"): boolean => {
					return type === "toDynamo" ? val instanceof Date : typeof val === "number";
				}
			})
		}, "jsType": Date}),
		new DynamoDBType({"name": "Combine", "dynamodbType": stringType, "set": false, "jsType": String}),
		new DynamoDBType({"name": "Constant", "dynamicName": (typeSettings?: AttributeDefinitionTypeSettings): string => {
			return `constant ${typeof typeSettings.value} (${typeSettings.value})`;
		}, "customType": {
			"functions": (typeSettings: AttributeDefinitionTypeSettings): {isOfType: (val: string | boolean | number, type: "toDynamo" | "fromDynamo") => boolean} => ({
				"isOfType": (val: string | boolean | number): boolean => typeSettings.value === val
			})
		}, "jsType": {"func": (val, typeSettings): boolean => val === typeSettings.value}, "dynamodbType": (typeSettings?: AttributeDefinitionTypeSettings): string | string[] => {
			switch (typeof typeSettings.value) {
			case "string":
				return stringType.dynamodbType as any;
			case "boolean":
				return booleanType.dynamodbType as any;
			case "number":
				return numberType.dynamodbType as any;
			}
		}}),
		new DynamoDBType({"name": "Model", "customDynamoName": (typeSettings?: AttributeDefinitionTypeSettings): string => {
			const model = typeSettings.model.Model;
			const hashKey = model.getHashKey();
			const typeDetails: DynamoDBTypeResult | DynamoDBSetTypeResult = model.schemas[0].getAttributeTypeDetails(hashKey) as DynamoDBTypeResult | DynamoDBSetTypeResult; // This has no potiental of being an array because a hashKey is not allowed to have multiple type options
			return typeDetails.name;
		}, "dynamicName": (typeSettings?: AttributeDefinitionTypeSettings): string => typeSettings.model.Model.name, "dynamodbType": (typeSettings?: AttributeDefinitionTypeSettings): string | string[] => {
			const model = typeSettings.model.Model;
			const hashKey = model.getHashKey();
			const rangeKey = model.getRangeKey();
			return rangeKey ? "M" : model.schemas[0].getAttributeType(hashKey);
		}, "set": (typeSettings?: AttributeDefinitionTypeSettings): boolean => {
			return !typeSettings.model.Model.getRangeKey();
		}, "jsType": {"func": (val): boolean => val.prototype instanceof Document}, "customType": {
			"functions": (typeSettings?: AttributeDefinitionTypeSettings): {toDynamo: (val: any) => any; fromDynamo: (val: any) => any; isOfType: (val: any, type: "toDynamo" | "fromDynamo") => boolean} => ({
				"toDynamo": (val: any): any => {
					const model = typeSettings.model.Model;
					const hashKey = model.getHashKey();
					const rangeKey = model.getRangeKey();
					if (rangeKey) {
						return {
							[hashKey]: val[hashKey],
							[rangeKey]: val[rangeKey]
						};
					} else {
						return val[hashKey] ?? val;
					}
				},
				"fromDynamo": (val: any): any => val,
				"isOfType": (val: any, type: "toDynamo" | "fromDynamo"): boolean => {
					const model = typeSettings.model.Model;
					const hashKey = model.getHashKey();
					const rangeKey = model.getRangeKey();
					if (rangeKey) {
						return typeof val === "object" && val[hashKey] && val[rangeKey];
					} else {
						return utils.dynamoose.getValueTypeCheckResult(model.schemas[0], val[hashKey] ?? val, hashKey, {type}, {}).isValidType;
					}
				}
			})
		}})
	];
})();
const attributeTypes: (DynamoDBTypeResult | DynamoDBSetTypeResult)[] = utils.array_flatten(attributeTypesMain.filter((checkType) => !checkType.customType).map((checkType) => checkType.result()).map((a) => [a, a.set])).filter((a) => Boolean(a));

type SetValueType = {wrapperName: "Set"; values: ValueType[]; type: string /* TODO: should probably make this an enum */};
type GeneralValueType = string | boolean | number | Buffer | Date;
export type ValueType = GeneralValueType | {[key: string]: ValueType} | ValueType[] | SetValueType;
type AttributeType = string | StringConstructor | BooleanConstructor | NumberConstructor | typeof Buffer | DateConstructor | ObjectConstructor | ArrayConstructor | SetConstructor | symbol | Schema | ModelType<Document>;

export interface TimestampObject {
	createdAt?: string | string[];
	updatedAt?: string | string[];
}
interface SchemaSettings {
	timestamps?: boolean | TimestampObject;
	saveUnknown?: boolean | string[];
}
interface IndexDefinition {
	name?: string;
	global?: boolean;
	rangeKey?: string;
	project?: boolean | string[];
	throughput?: "ON_DEMAND" | number | {read: number; write: number};
}
interface AttributeDefinitionTypeSettings {
	storage?: "miliseconds" | "seconds";
	model?: ModelType<Document>;
	attributes?: string[];
	seperator?: string;
	value?: string | boolean | number;
}
interface AttributeDefinition {
	type: AttributeType | AttributeType[] | {value: DateConstructor; settings?: AttributeDefinitionTypeSettings} | {value: AttributeType | AttributeType[]}; // TODO add support for this being an object
	schema?: AttributeType | AttributeType[] | AttributeDefinition | AttributeDefinition[] | SchemaDefinition | SchemaDefinition[];
	default?: ValueType | (() => ValueType);
	forceDefault?: boolean;
	validate?: ValueType | RegExp | ((value: ValueType) => boolean);
	required?: boolean;
	enum?: ValueType[];
	get?: ((value: ValueType) => ValueType);
	set?: ((value: ValueType) => ValueType);
	index?: boolean | IndexDefinition | IndexDefinition[];
	hashKey?: boolean;
	rangeKey?: boolean;
}
export interface SchemaDefinition {
	[attribute: string]: AttributeType | AttributeType[] | AttributeDefinition | AttributeDefinition[];
}
interface SchemaGetAttributeTypeSettings {
	unknownAttributeAllowed: boolean;
}
interface SchemaGetAttributeSettingValue {
	returnFunction: boolean;
	typeIndexOptionMap?: any;
}

export class Schema {
	settings: SchemaSettings;
	schemaObject: SchemaDefinition;
	attributes: (object?: ObjectType) => string[];
	async getCreateTableAttributeParams (model: Model<Document>): Promise<Pick<DynamoDB.CreateTableInput, "AttributeDefinitions" | "KeySchema" | "GlobalSecondaryIndexes" | "LocalSecondaryIndexes">> {
		const hashKey = this.getHashKey();
		const AttributeDefinitions = [
			{
				"AttributeName": hashKey,
				"AttributeType": this.getSingleAttributeType(hashKey)
			}
		];
		const AttributeDefinitionsNames = [hashKey];
		const KeySchema = [
			{
				"AttributeName": hashKey,
				"KeyType": "HASH"
			}
		];

		const rangeKey = this.getRangeKey();
		if (rangeKey) {
			AttributeDefinitions.push({
				"AttributeName": rangeKey,
				"AttributeType": this.getSingleAttributeType(rangeKey)
			});
			AttributeDefinitionsNames.push(rangeKey);
			KeySchema.push({
				"AttributeName": rangeKey,
				"KeyType": "RANGE"
			});
		}

		utils.array_flatten(await Promise.all([this.getIndexAttributes(), this.getIndexRangeKeyAttributes()])).map((obj) => obj.attribute).forEach((index) => {
			if (AttributeDefinitionsNames.includes(index)) {
				return;
			}

			AttributeDefinitionsNames.push(index);
			AttributeDefinitions.push({
				"AttributeName": index,
				"AttributeType": this.getSingleAttributeType(index)
			});
		});

		return {
			AttributeDefinitions,
			KeySchema,
			...await this.getIndexes(model)
		};
	}
	// This function has the same behavior as `getAttributeType` except if the schema has multiple types, it will throw an error. This is useful for attribute definitions and keys for when you are only allowed to have one type for an attribute
	private getSingleAttributeType (key: string, value?: ValueType, settings?: SchemaGetAttributeTypeSettings): string {
		const attributeType = this.getAttributeType(key, value, settings);
		if (Array.isArray(attributeType)) {
			throw new CustomError.InvalidParameter(`You can not have multiple types for attribute definition: ${key}.`);
		}
		return attributeType;
	}
	getAttributeType (key: string, value?: ValueType, settings?: SchemaGetAttributeTypeSettings): string | string[] {
		try {
			const typeDetails = this.getAttributeTypeDetails(key);
			return Array.isArray(typeDetails) ? (typeDetails as any).map((detail) => detail.dynamodbType) : typeDetails.dynamodbType;
		} catch (e) {
			if (settings?.unknownAttributeAllowed && e.message === `Invalid Attribute: ${key}` && value) {
				return Object.keys((Document as any).objectToDynamo(value, {"type": "value"}))[0];
			} else {
				throw e;
			}
		}
	}
	static attributeTypes = {
		"findDynamoDBType": (type): DynamoDBTypeResult | DynamoDBSetTypeResult => attributeTypes.find((checkType) => checkType.dynamodbType === type),
		"findTypeForValue": (...args): DynamoDBTypeResult | DynamoDBSetTypeResult => attributeTypes.find((checkType) => (checkType.isOfType as any)(...args))
	};

	getHashKey: () => string;
	getRangeKey: () => string | void;
	// This function will take in an attribute and value, and returns the default value if it should be applied.
	async defaultCheck (key: string, value: ValueType, settings: any): Promise<ValueType | void> {
		const isValueUndefined = typeof value === "undefined" || value === null;
		if (settings.defaults && isValueUndefined || settings.forceDefault && await this.getAttributeSettingValue("forceDefault", key)) {
			const defaultValueRaw = await this.getAttributeSettingValue("default", key);

			let hasMultipleTypes;
			try {
				hasMultipleTypes = Array.isArray(this.getAttributeType(key));
			} catch (e) {
				hasMultipleTypes = false;
			}

			const defaultValue = Array.isArray(defaultValueRaw) && hasMultipleTypes ? defaultValueRaw[0] : defaultValueRaw;
			const isDefaultValueUndefined = typeof defaultValue === "undefined" || defaultValue === null;
			if (!isDefaultValueUndefined) {
				return defaultValue;
			}
		}
	}
	requiredCheck: (key: string, value: ValueType) => Promise<void>;
	getAttributeSettingValue (setting: string, key: string, settings: SchemaGetAttributeSettingValue = {"returnFunction": false}): any {
		function func (attributeValue): any {
			const defaultPropertyValue = (attributeValue || {})[setting];
			return typeof defaultPropertyValue === "function" && !settings.returnFunction ? defaultPropertyValue() : defaultPropertyValue;
		}
		const attributeValue = this.getAttributeValue(key, {"typeIndexOptionMap": settings.typeIndexOptionMap});
		if (Array.isArray(attributeValue)) {
			return attributeValue.map(func);
		} else {
			return func(attributeValue);
		}
	}
	getTypePaths (object: ObjectType, settings: { type: "toDynamo" | "fromDynamo"; previousKey?: string; includeAllProperties?: boolean } = {"type": "toDynamo"}): ObjectType {
		return Object.entries(object).reduce((result, entry) => {
			const [key, value] = entry;
			const fullKey = [settings.previousKey, key].filter((a) => Boolean(a)).join(".");
			let typeCheckResult;
			try {
				typeCheckResult = utils.dynamoose.getValueTypeCheckResult(this, value, fullKey, settings, {});
			} catch (e) {
				if (result && settings.includeAllProperties) {
					result[fullKey] = {
						"index": 0,
						"matchCorrectness": 0.5,
						"entryCorrectness": [0.5]
					};
				}
				return result;
			}
			const {typeDetails, matchedTypeDetailsIndex, matchedTypeDetailsIndexes} = typeCheckResult;
			const hasMultipleTypes = Array.isArray(typeDetails);
			// Added Fix for differentiating Buffer from rest of object types to avoid iterating over entries in Buffer
			const isObject = typeof value === "object" && !(value instanceof Buffer) && value !== null;

			if (hasMultipleTypes) {
				if (matchedTypeDetailsIndexes.length > 1 && isObject) {
					result[fullKey] = matchedTypeDetailsIndexes.map((index: number) => {
						const entryCorrectness = utils.object.entries(value).map((entry) => {
							const [subKey, subValue] = entry;

							try {
								const {isValidType} = utils.dynamoose.getValueTypeCheckResult(this, subValue, `${fullKey}.${subKey}`, settings, {"typeIndexOptionMap": {[fullKey]: index}});
								return isValidType ? 1 : 0;
							} catch (e) {
								return 0.5;
							}
						});
						return {
							index,
							// 1 = full match
							// 0.5 = attributes don't exist
							// 0 = types don't match
							"matchCorrectness": Math.min(...entryCorrectness),
							entryCorrectness
						};
					}).sort((a, b) => {
						if (a.matchCorrectness === b.matchCorrectness) {
							return b.entryCorrectness.reduce((a: number, b: number) => a + b, 0) - a.entryCorrectness.reduce((a: number, b: number) => a + b, 0);
						} else {
							return b.matchCorrectness - a.matchCorrectness;
						}
					}).map((a) => a.index)[0];
				}

				if (result[fullKey] === undefined) {
					result[fullKey] = matchedTypeDetailsIndex;
				}
			} else if (settings.includeAllProperties) {
				const matchCorrectness: number = typeCheckResult.isValidType ? 1 : 0;
				result[fullKey] = {
					"index": 0,
					matchCorrectness,
					"entryCorrectness": [matchCorrectness]
				};
			}

			if (isObject) {
				result = {...result, ...this.getTypePaths(value, {...settings, "previousKey": fullKey})};
			}

			return result;
		}, {});
	}
	getIndexAttributes: () => Promise<{ index: IndexDefinition; attribute: string }[]>;
	getSettingValue: (setting: string) => any;
	getAttributeTypeDetails: (key: string, settings?: { standardKey?: boolean; typeIndexOptionMap?: {} }) => DynamoDBTypeResult | DynamoDBSetTypeResult | DynamoDBTypeResult[] | DynamoDBSetTypeResult[];
	getAttributeValue: (key: string, settings?: { standardKey?: boolean; typeIndexOptionMap?: {} }) => AttributeDefinition;
	getIndexes: (model: Model<Document>) => Promise<{ GlobalSecondaryIndexes?: IndexItem[]; LocalSecondaryIndexes?: IndexItem[] }>;
	getIndexRangeKeyAttributes: () => Promise<{ attribute: string }[]>;

	constructor (object: SchemaDefinition, settings: SchemaSettings = {}) {
		if (!object || typeof object !== "object" || Array.isArray(object)) {
			throw new CustomError.InvalidParameterType("Schema initalization parameter must be an object.");
		}
		if (Object.keys(object).length === 0) {
			throw new CustomError.InvalidParameter("Schema initalization parameter must not be an empty object.");
		}

		if (settings.timestamps === true) {
			settings.timestamps = {
				"createdAt": "createdAt",
				"updatedAt": "updatedAt"
			};
		}
		if (settings.timestamps) {
			const createdAtArray = Array.isArray(settings.timestamps.createdAt) ? settings.timestamps.createdAt : [settings.timestamps.createdAt];
			const updatedAtArray = Array.isArray(settings.timestamps.updatedAt) ? settings.timestamps.updatedAt : [settings.timestamps.updatedAt];

			[...createdAtArray, ...updatedAtArray].forEach((prop) => {
				if (object[prop]) {
					throw new CustomError.InvalidParameter("Timestamp attributes must not be defined in schema.");
				}

				object[prop] = Date;
			});
		}

		let parsedSettings = {...settings};
		const parsedObject = {...object};
		utils.object.entries(parsedObject).filter((entry) => entry[1] instanceof Schema).forEach((entry) => {
			const [key, value] = entry;
			let newValue = {
				"type": Object,
				"schema": (value as any).schemaObject
			};
			if (key.endsWith(".schema")) {
				newValue = (value as any).schemaObject;
			}

			const subSettings = {...(value as any).settings};
			Object.entries(subSettings).forEach((entry) => {
				const [settingsKey, settingsValue] = entry;
				switch (settingsKey) {
				case "saveUnknown":
					subSettings[settingsKey] = typeof subSettings[settingsKey] === "boolean" ? [`${key}.**`] : (settingsValue as any).map((val) => `${key}.${val}`);
					break;
				case "timestamps":
					subSettings[settingsKey] = Object.entries(subSettings[settingsKey]).reduce((obj, entity) => {
						const [subKey, subValue] = entity;

						obj[subKey] = Array.isArray(subValue) ? subValue.map((subValue) => `${key}.${subValue}`) : `${key}.${subValue}`;

						return obj;
					}, {});
					break;
				}
			});
			parsedSettings = utils.merge_objects.main({"combineMethod": "array_merge_new_arrray"})(parsedSettings, subSettings);

			utils.object.set(parsedObject, key, newValue);
		});
		utils.object.entries(parsedObject).forEach((entry) => {
			const key = entry[0];
			const value = entry[1] as any;

			if (!key.endsWith(".type") && !key.endsWith(".0")) {
				if (value && value.Model && value.Model instanceof Model) {
					utils.object.set(parsedObject, key, {"type": value});
				} else if (value && Array.isArray(value)) {
					value.forEach((item, index) => {
						if (item && item.Model && item.Model instanceof Model) {
							utils.object.set(parsedObject, `${key}.${index}`, {"type": item});
						}
					});
				}
			}
		});

		// Anytime `this.schemaObject` is modified, `this[internalCache].attributes` must be set to undefined or null
		this.schemaObject = parsedObject;
		this.settings = parsedSettings;

		const checkAttributeNameDots = (object: SchemaDefinition/*, existingKey = ""*/): void => {
			Object.keys(object).forEach((key) => {
				if (key.includes(".")) {
					throw new CustomError.InvalidParameter("Attributes must not contain dots.");
				}

				// TODO: lots of `as` statements in the two lines below. We should clean that up.
				if (typeof object[key] === "object" && object[key] !== null && (object[key] as AttributeDefinition).schema) {
					checkAttributeNameDots((object[key] as AttributeDefinition).schema as SchemaDefinition/*, key*/);
				}
			});
		};
		checkAttributeNameDots(this.schemaObject);

		const checkMultipleArraySchemaElements = (key: string): void => {
			let attributeType: string[] = [];
			try {
				const tmpAttributeType = this.getAttributeType(key);
				attributeType = Array.isArray(tmpAttributeType) ? tmpAttributeType : [tmpAttributeType];
			} catch (e) {} // eslint-disable-line no-empty

			if (attributeType.some((type) => type === "L") && ((this.getAttributeValue(key).schema || []) as any).length > 1) {
				throw new CustomError.InvalidParameter("You must only pass one element into schema array.");
			}
		};
		this.attributes().forEach((key) => checkMultipleArraySchemaElements(key));

		const hashrangeKeys = this.attributes().reduce((val, key) => {
			const hashKey = this.getAttributeSettingValue("hashKey", key);
			const rangeKey = this.getAttributeSettingValue("rangeKey", key);

			const isHashKey = Array.isArray(hashKey) ? hashKey.every((item) => Boolean(item)) : hashKey;
			const isRangeKey = Array.isArray(rangeKey) ? rangeKey.every((item) => Boolean(item)) : rangeKey;

			if (isHashKey) {
				val.hashKeys.push(key);
			}
			if (isRangeKey) {
				val.rangeKeys.push(key);
			}
			if (isHashKey && isRangeKey) {
				val.hashAndRangeKeyAttributes.push(key);
			}

			return val;
		}, {"hashKeys": [], "rangeKeys": [], "hashAndRangeKeyAttributes": []});
		const keyTypes = ["hashKey", "rangeKey"];
		keyTypes.forEach((keyType) => {
			if (hashrangeKeys[`${keyType}s`].length > 1) {
				throw new CustomError.InvalidParameter(`Only one ${keyType} allowed per schema.`);
			}
			if (hashrangeKeys[`${keyType}s`].find((key) => key.includes("."))) {
				throw new CustomError.InvalidParameter(`${keyType} must be at root object and not nested in object or array.`);
			}
		});
		if (hashrangeKeys.hashAndRangeKeyAttributes.length > 0) {
			throw new CustomError.InvalidParameter(`Attribute ${hashrangeKeys.hashAndRangeKeyAttributes[0]} must not be both hashKey and rangeKey`);
		}

		this.attributes().forEach((key) => {
			const attributeSettingValue = this.getAttributeSettingValue("index", key);
			if (key.includes(".") && (Array.isArray(attributeSettingValue) ? attributeSettingValue.some((singleValue) => Boolean(singleValue)) : attributeSettingValue)) {
				throw new CustomError.InvalidParameter("Index must be at root object and not nested in object or array.");
			}
		});
	}
}

// TODO: in the two functions below I don't think we should be using as. We should try to clean that up.
Schema.prototype.getHashKey = function (this: Schema): string {
	return Object.keys(this.schemaObject).find((key) => (this.schemaObject[key] as AttributeDefinition).hashKey) || Object.keys(this.schemaObject)[0];
};
Schema.prototype.getRangeKey = function (this: Schema): string | void {
	return Object.keys(this.schemaObject).find((key) => (this.schemaObject[key] as AttributeDefinition).rangeKey);
};

// This function will take in an attribute and value, and throw an error if the property is required and the value is undefined or null.
Schema.prototype.requiredCheck = async function (this: Schema, key: string, value: ValueType): Promise<void> {
	const isRequired = await this.getAttributeSettingValue("required", key);
	if ((typeof value === "undefined" || value === null) && (Array.isArray(isRequired) ? isRequired.some((val) => Boolean(val)) : isRequired)) {
		throw new CustomError.ValidationError(`${key} is a required property but has no value when trying to save document`);
	}
};

Schema.prototype.getIndexAttributes = async function (this: Schema): Promise<{index: IndexDefinition; attribute: string}[]> {
	return (await Promise.all(this.attributes()
		.map(async (attribute: string) => ({
			"index": await this.getAttributeSettingValue("index", attribute) as IndexDefinition,
			attribute
		}))
	))
		.filter((obj) => Array.isArray(obj.index) ? obj.index.some((index) => Boolean(index)) : obj.index)
		.reduce((accumulator, currentValue) => {
			if (Array.isArray(currentValue.index)) {
				currentValue.index.forEach((currentIndex) => {
					accumulator.push({
						...currentValue,
						"index": currentIndex
					});
				});
			} else {
				accumulator.push(currentValue);
			}
			return accumulator;
		}, []);
};
Schema.prototype.getIndexRangeKeyAttributes = async function (this: Schema): Promise<{attribute: string}[]> {
	const indexes: ({index: IndexDefinition; attribute: string})[] = await this.getIndexAttributes();
	return indexes.map((index) => index.index.rangeKey).filter((a) => Boolean(a)).map((a) => ({"attribute": a}));
};
export interface IndexItem {
	IndexName: string;
	KeySchema: ({AttributeName: string; KeyType: "HASH" | "RANGE"})[];
	Projection: {ProjectionType: "KEYS_ONLY" | "INCLUDE" | "ALL"; NonKeyAttributes?: string[]};
	ProvisionedThroughput?: {"ReadCapacityUnits": number; "WriteCapacityUnits": number}; // TODO: this was copied from get_provisioned_throughput. We should change this to be an actual interface
}
Schema.prototype.getIndexes = async function (this: Schema, model: Model<Document>): Promise<{GlobalSecondaryIndexes?: IndexItem[]; LocalSecondaryIndexes?: IndexItem[]}> {
	return (await this.getIndexAttributes()).reduce((accumulator, currentValue) => {
		const indexValue = currentValue.index;
		const attributeValue = currentValue.attribute;

		const dynamoIndexObject: IndexItem = {
			"IndexName": indexValue.name || `${attributeValue}${indexValue.global ? "GlobalIndex" : "LocalIndex"}`,
			"KeySchema": [],
			"Projection": {"ProjectionType": "KEYS_ONLY"}
		};
		if (indexValue.project || typeof indexValue.project === "undefined" || indexValue.project === null) {
			dynamoIndexObject.Projection = Array.isArray(indexValue.project) ? {"ProjectionType": "INCLUDE", "NonKeyAttributes": indexValue.project} : {"ProjectionType": "ALL"};
		}
		if (indexValue.global) {
			dynamoIndexObject.KeySchema.push({"AttributeName": attributeValue, "KeyType": "HASH"});
			if (indexValue.rangeKey) {
				dynamoIndexObject.KeySchema.push({"AttributeName": indexValue.rangeKey, "KeyType": "RANGE"});
			}
			const throughputObject = utils.dynamoose.get_provisioned_throughput(indexValue.throughput ? indexValue : model.options.throughput === "ON_DEMAND" ? {} : model.options);
			// TODO: fix up the two lines below. Using too many `as` statements.
			if ((throughputObject as {"ProvisionedThroughput": {"ReadCapacityUnits": number; "WriteCapacityUnits": number}}).ProvisionedThroughput) {
				dynamoIndexObject.ProvisionedThroughput = (throughputObject as {"ProvisionedThroughput": {"ReadCapacityUnits": number; "WriteCapacityUnits": number}}).ProvisionedThroughput;
			}
		} else {
			dynamoIndexObject.KeySchema.push({"AttributeName": this.getHashKey(), "KeyType": "HASH"});
			dynamoIndexObject.KeySchema.push({"AttributeName": attributeValue, "KeyType": "RANGE"});
		}
		const accumulatorKey = indexValue.global ? "GlobalSecondaryIndexes" : "LocalSecondaryIndexes";
		if (!accumulator[accumulatorKey]) {
			accumulator[accumulatorKey] = [];
		}
		accumulator[accumulatorKey].push(dynamoIndexObject);

		return accumulator;
	}, {});
};

Schema.prototype.getSettingValue = function (this: Schema, setting: string): any {
	return this.settings[setting];
};

function attributesAction (this: Schema, object?: ObjectType): string[] {
	const typePaths = object && this.getTypePaths(object);
	const main = (object: SchemaDefinition, existingKey = ""): string[] => {
		return Object.keys(object).reduce((accumulator: string[], key) => {
			const keyWithExisting = `${existingKey ? `${existingKey}.` : ""}${key}`;
			accumulator.push(keyWithExisting);

			let attributeType: string[];
			try {
				const tmpAttributeType = this.getAttributeType(keyWithExisting);
				attributeType = Array.isArray(tmpAttributeType) ? tmpAttributeType : [tmpAttributeType];
			} catch (e) {} // eslint-disable-line no-empty

			// TODO: using too many `as` statements in the few lines below. Clean that up.
			function recursive (type, arrayTypeIndex): void {
				if ((type === "M" || type === "L") && ((object[key][arrayTypeIndex] || object[key]) as AttributeDefinition).schema) {
					accumulator.push(...main(((object[key][arrayTypeIndex] || object[key]) as AttributeDefinition).schema as SchemaDefinition, keyWithExisting));
				}
			}
			if (attributeType) {
				if (typePaths && typePaths[keyWithExisting] !== undefined) {
					const index = typePaths[keyWithExisting];
					const type = attributeType[index];
					recursive(type, index);
				} else {
					attributeType.forEach(recursive);
				}
			}
			// ------------------------------

			return accumulator;
		}, []);
	};

	return main(this.schemaObject);
}
Schema.prototype.attributes = function (this: Schema, object?: ObjectType): string[] {
	return attributesAction.call(this, object);
};

Schema.prototype.getAttributeValue = function (this: Schema, key: string, settings?: {standardKey?: boolean; typeIndexOptionMap?: {}}): AttributeDefinition {
	const previousKeyParts = [];
	let result = (settings?.standardKey ? key : key.replace(/\.\d+/gu, ".0")).split(".").reduce((result, part) => {
		if (Array.isArray(result)) {
			const predefinedIndex = settings && settings.typeIndexOptionMap && settings.typeIndexOptionMap[previousKeyParts.join(".")];
			if (predefinedIndex !== undefined) {
				result = result[predefinedIndex];
			} else {
				result = result.find((item) => item.schema && item.schema[part]);
			}
		}
		previousKeyParts.push(part);
		return utils.object.get(result.schema, part);
	}, {"schema": this.schemaObject} as any);

	if (Array.isArray(result)) {
		const predefinedIndex = settings && settings.typeIndexOptionMap && settings.typeIndexOptionMap[previousKeyParts.join(".")];
		if (predefinedIndex !== undefined) {
			result = result[predefinedIndex];
		}
	}

	return result;
};

function retrieveTypeInfo (type: string, isSet: boolean, key: string, typeSettings: AttributeDefinitionTypeSettings): DynamoDBTypeResult | DynamoDBSetTypeResult {
	const foundType = attributeTypesMain.find((checkType) => checkType.name.toLowerCase() === type.toLowerCase());
	if (!foundType) {
		throw new CustomError.InvalidType(`${key} contains an invalid type: ${type}`);
	}
	const parentType = foundType.result(typeSettings);
	if (!parentType.set && isSet) {
		throw new CustomError.InvalidType(`${key} with type: ${type} is not allowed to be a set`);
	}
	return isSet ? parentType.set : parentType;
}
// TODO: using too many `as` statements in the function below. We should clean this up.
Schema.prototype.getAttributeTypeDetails = function (this: Schema, key: string, settings: {standardKey?: boolean; typeIndexOptionMap?: {}} = {}): DynamoDBTypeResult | DynamoDBSetTypeResult | DynamoDBTypeResult[] | DynamoDBSetTypeResult[] {
	const standardKey = settings.standardKey ? key : key.replace(/\.\d+/gu, ".0");
	const val = this.getAttributeValue(standardKey, {...settings, "standardKey": true});
	if (typeof val === "undefined") {
		throw new CustomError.UnknownAttribute(`Invalid Attribute: ${key}`);
	}
	let typeVal = typeof val === "object" && !Array.isArray(val) && val.type ? val.type : val;
	let typeSettings: AttributeDefinitionTypeSettings = {};
	if (typeof typeVal === "object" && !Array.isArray(typeVal)) {
		typeSettings = (typeVal as {value: DateConstructor; settings?: AttributeDefinitionTypeSettings}).settings || {};
		typeVal = (typeVal as any).value;
	}

	const getType = (typeVal: AttributeType | AttributeDefinition): string => {
		let type: string;
		const isThisType = typeVal as any === Internal.Public.this;
		const isNullType = typeVal as any === Internal.Public.null;
		if (typeof typeVal === "function" || isThisType) {
			if ((typeVal as any).prototype instanceof Document || isThisType) {
				type = "model";

				if (isThisType) {
					typeSettings.model = {
						"Model": {
							"getHashKey": this.getHashKey.bind(this),
							"getRangeKey": this.getRangeKey.bind(this),
							"schemas": [this]
						}
					} as any;
				} else {
					typeSettings.model = typeVal as any;
				}
			} else {
				const regexFuncName = /^Function ([^(]+)\(/iu;
				[, type] = typeVal.toString().match(regexFuncName);
			}
		} else if (isNullType) {
			type = "null";
		} else {
			type = typeVal as string;
		}
		return type;
	};

	const result: DynamoDBTypeResult[] | DynamoDBSetTypeResult[] = ((Array.isArray(typeVal) ? typeVal : [typeVal]) as any).map((item, index: number) => {
		item = typeof item === "object" && !Array.isArray(item) && item.type ? item.type : item;
		if (typeof item === "object" && !Array.isArray(item)) {
			typeSettings = (item as {value: DateConstructor; settings?: AttributeDefinitionTypeSettings}).settings || {};
			item = item.value;
		}

		let type = getType(item);
		const isSet = type.toLowerCase() === "set";
		if (isSet) {
			let schemaValue = this.getAttributeSettingValue("schema", key);
			if (Array.isArray(schemaValue[index])) {
				schemaValue = schemaValue[index];
			}
			const subValue = schemaValue[0];
			type = getType(typeof subValue === "object" && subValue.type ? subValue.type : subValue);
		}

		const returnObject = retrieveTypeInfo(type, isSet, key, typeSettings);
		return returnObject;
	});

	const returnObject = result.length < 2 ? result[0] : result;
	return returnObject;
};
