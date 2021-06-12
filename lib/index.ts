import {Model} from "./Model";
import {Schema, SchemaDefinition} from "./Schema";
import {Condition} from "./Condition";
import transaction from "./Transaction";
import aws = require("./aws");
import Internal = require("./Internal");
import utils = require("./utils");
import {Item, AnyItem} from "./Item";
import ModelStore = require("./ModelStore");
import {ModelType} from "./General";
import {CustomError} from "dynamoose-utils";
import {Table} from "./Table";

const model = <T extends Item = AnyItem>(name: string, schema?: Schema | SchemaDefinition | (Schema | SchemaDefinition)[]): ModelType<T> => {
	let model: Model<T>;
	let storedSchema: Model<T>;
	if (name) {
		storedSchema = ModelStore<T>(name);
	}
	// TODO: this is something I'd like to do. But is a breaking change. Need to enable this and uncomment it in a breaking release. Also will need to fix the tests as well.
	/* if (schema && storedSchema) {
		throw new CustomError.InvalidParameter(`Model with name ${name} has already been registered.`);
	} else */
	if (!schema && storedSchema) {
		model = storedSchema;
	} else {
		model = new Model(name, schema);
	}
	const returnObject: any = model.Item;
	const keys = utils.array_flatten([
		Object.keys(model),
		Object.keys(Object.getPrototypeOf(model)),
		Object.getOwnPropertyNames(Object.getPrototypeOf(model))
	]).filter((key) => !["constructor", "name"].includes(key));
	keys.forEach((key) => {
		if (typeof model[key] === "object") {
			const main = (key: string): void => {
				utils.object.set(returnObject, key, {});
				const value = utils.object.get(model as any, key);
				if (value === null || value.constructor !== Object && value.constructor !== Array) {
					utils.object.set(returnObject, key, value);
				} else {
					Object.keys(value).forEach((subKey): void => {
						const newKey = `${key}.${subKey}`;
						const subValue: any = utils.object.get(model as any, newKey);
						if (typeof subValue === "object") {
							main(newKey);
						} else {
							utils.object.set(returnObject, newKey, subValue.bind(model));
						}
					});
				}
			};
			main(key);
		} else {
			returnObject[key] = model[key].bind(model);
		}
	});

	Object.defineProperty(returnObject, "name", {
		"configurable": false,
		"value": returnObject.Model.name
	});

	return returnObject as any;
};
Table.defaults = {
	...require("./Table/defaults").custom
};

export = {
	model,
	Table,
	Schema,
	Condition,
	transaction,
	aws,
	"logger": async () => {
		try {
			return await utils.importPackage("dynamoose-logger");
		} catch (error) {
			throw new CustomError.OtherError("dynamoose-logger has not been installed. Install it using `npm i --save-dev dynamoose-logger`.");
		}
	},
	"UNDEFINED": Internal.Public.undefined,
	"THIS": Internal.Public.this,
	"NULL": Internal.Public.null
};
