import ddb = require("./aws/ddb/internal");
import DynamoDB = require("@aws-sdk/client-dynamodb");
import utils = require("./utils");
import Error = require("./Error");
import {Model} from "./Model";
import * as ModelStore from "./ModelStore";
import {CallbackType} from "./General";
import {Item} from "./Item";
import Internal = require("./Internal");
const {internalProperties} = Internal.General;

export enum TransactionReturnOptions {
	request = "request",
	items = "items"
}
enum TransactionType {
	get = "get",
	write = "write"
}
export interface TransactionSettings {
	return: TransactionReturnOptions;
	type?: TransactionType;
}

export type GetTransactionInput = {Get: DynamoDB.GetItemInput};
export type CreateTransactionInput = {Put: DynamoDB.PutItemInput};
export type DeleteTransactionInput = {Delete: DynamoDB.DeleteItemInput};
export type UpdateTransactionInput = {Update: DynamoDB.UpdateItemInput};
export type ConditionTransactionInput = {ConditionCheck: DynamoDB.ConditionCheck};

type Transaction =
	GetTransactionInput |
	CreateTransactionInput |
	DeleteTransactionInput |
	UpdateTransactionInput |
	ConditionTransactionInput;

type Transactions = (Transaction | Promise<Transaction>)[];
type TransactionCallback = CallbackType<any, any>;
type TransactionReturnType = any;

/* Define overloads / signatures for Transaction method */
function Transaction (transactions: Transactions): TransactionReturnType;
function Transaction (transactions: Transactions, settings: TransactionSettings): TransactionReturnType;
function Transaction (transactions: Transactions, callback: TransactionCallback): TransactionReturnType;
function Transaction (transaction: Transactions, settings: TransactionSettings, callback: TransactionCallback): TransactionReturnType;
function Transaction (transactions: Transactions, settings?: TransactionSettings | TransactionCallback, callback?: TransactionCallback): TransactionReturnType {
	settings = settings ?? {"return": TransactionReturnOptions.items};

	if (typeof settings === "function") {
		callback = settings;
		settings = {"return": TransactionReturnOptions.items};
	}
	if (typeof transactions === "function") {
		callback = transactions;
		transactions = null;
	}

	const promise = (async (): Promise<any> => {
		if (!Array.isArray(transactions) || transactions.length <= 0) {
			throw new Error.InvalidParameter("You must pass in an array with items for the transactions parameter.");
		}

		const transactionObjects = await Promise.all(transactions);

		const transactionParams = {
			"TransactItems": transactionObjects
		};

		if (settings.return === TransactionReturnOptions.request) {
			return transactionParams;
		}

		let transactionType: "transactGetItems" | "transactWriteItems";
		if (settings.type) {
			switch (settings.type) {
			case TransactionType.get:
				transactionType = "transactGetItems";
				break;
			case TransactionType.write:
				transactionType = "transactWriteItems";
				break;
			default:
				throw new Error.InvalidParameter("Invalid type option, please pass in \"get\" or \"write\".");
			}
		} else {
			transactionType = transactionObjects.map((a) => Object.keys(a)[0]).every((key) => key === "Get") ? "transactGetItems" : "transactWriteItems";
		}

		const modelNames: string[] = transactionObjects.map((a) => (Object.values(a)[0] as any).TableName);
		const uniqueModelNames = utils.unique_array_elements(modelNames);
		const models: Model<Item>[] = uniqueModelNames.map((name) => ModelStore(name));
		models.forEach((model, index) => {
			if (!model) {
				throw new Error.InvalidParameter(`Model "${uniqueModelNames[index]}" not found. Please register the model with dynamoose before using it in transactions.`);
			}
		});
		await Promise.all(models.map((model) => model[internalProperties].table()[internalProperties].pendingTaskPromise()));

		// TODO: remove `as any` here (https://stackoverflow.com/q/61111476/894067)
		const result: any = await ddb(transactionType as any, transactionParams as any);
		return result.Responses ? await Promise.all(result.Responses.map((item, index: number) => {
			const modelName: string = modelNames[index];
			const model: Model<Item> = models.find((model) => model.name === modelName);
			return new model.Item(item.Item, {"type": "fromDynamo"}).conformToSchema({"customTypesDynamo": true, "checkExpiredItem": true, "saveUnknown": true, "type": "fromDynamo"});
		})) : null;
	})();

	if (callback) {
		promise.then((result) => callback(null, result)).catch((error) => callback(error));
	} else {
		return promise;
	}
}

export default Transaction;
