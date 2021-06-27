import * as ddb from "./index";
import log = require("../../logger/emitter");
import {DynamoDB} from "aws-sdk";

// Table
async function main (method: "describeTable", params: DynamoDB.DescribeTableInput): Promise<DynamoDB.DescribeTableOutput>;
async function main (method: "createTable", params: DynamoDB.CreateTableInput): Promise<DynamoDB.CreateTableOutput>;
async function main (method: "updateTable", params: DynamoDB.UpdateTableInput): Promise<DynamoDB.UpdateTableOutput>;
async function main (method: "updateTimeToLive", params: DynamoDB.UpdateTimeToLiveInput): Promise<DynamoDB.UpdateTimeToLiveOutput>;
async function main (method: "describeTimeToLive", params: DynamoDB.DescribeTimeToLiveInput): Promise<DynamoDB.DescribeTimeToLiveOutput>;

// Item
async function main (method: "getItem", params: DynamoDB.GetItemInput): Promise<DynamoDB.GetItemOutput>;
async function main (method: "deleteItem", params: DynamoDB.DeleteItemInput): Promise<DynamoDB.DeleteItemOutput>;
async function main (method: "updateItem", params: DynamoDB.UpdateItemInput): Promise<DynamoDB.UpdateItemOutput>;
async function main (method: "putItem", params: DynamoDB.PutItemInput): Promise<DynamoDB.PutItemOutput>;
async function main (method: "batchWriteItem", params: DynamoDB.BatchWriteItemInput): Promise<DynamoDB.BatchWriteItemOutput>;
async function main (method: "batchGetItem", params: DynamoDB.BatchGetItemInput): Promise<DynamoDB.BatchGetItemOutput>;

// Document Retriever
async function main (method: "query", params: DynamoDB.QueryInput): Promise<DynamoDB.QueryOutput>;
async function main (method: "scan", params: DynamoDB.ScanInput): Promise<DynamoDB.ScanOutput>;

// Transaction
async function main (method: "transactGetItems", params: DynamoDB.TransactGetItemsInput): Promise<DynamoDB.TransactGetItemsOutput>;
async function main (method: "transactWriteItems", params: DynamoDB.TransactWriteItemsInput): Promise<DynamoDB.TransactWriteItemsOutput>;

async function main (method: string, params: any): Promise<any> {
	const func = ddb()[method](params);

	// Retrieve Dynamodb Transactions Cancellation Reasons Error if method related to transaction
	if (method === "transactGetItems" || method === "transactWriteItems") {
		func.on("extractError", ({error, httpResponse}) => {
			if (error) {
				const {CancellationReasons} = JSON.parse(httpResponse.body.toString());
				error.CancellationReasons = CancellationReasons;
			}
		});
	}

	log({"level": "debug", "category": `aws:dynamodb:${method}:request`, "message": JSON.stringify(params, null, 4), "payload": {"request": params}});
	const result = await func.promise();
	log({"level": "debug", "category": `aws:dynamodb:${method}:response`, "message": typeof result === "undefined" ? "undefined" : JSON.stringify(result, null, 4), "payload": {"response": result}});
	return result;
}

export = main;
