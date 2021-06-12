const chaiAsPromised = require("chai-as-promised");
const chai = require("chai");
chai.use(chaiAsPromised);
const {expect} = chai;
const dynamoose = require("../../dist");
const util = require("util");
const ModelStore = require("../../dist/ModelStore");

describe("Transaction", () => {
	it("Should be a function", () => {
		expect(dynamoose.transaction).to.be.a("function");
	});

	const functionCallTypes = [
		{"name": "Promise", "func": (func) => func},
		{"name": "Callback", "func": (func) => util.promisify(func)}
	];
	functionCallTypes.forEach((callType) => {
		describe(callType.name, () => {
			beforeEach(() => {
				dynamoose.Table.defaults.set({
					"create": false,
					"waitForActive": false
				});
			});
			afterEach(() => {
				dynamoose.Table.defaults.set({});
				dynamoose.aws.ddb.revert();
				ModelStore.clear();
			});

			it("Should throw an error if nothing passed in", () => {
				return expect(callType.func(dynamoose.transaction)()).to.be.rejectedWith("You must pass in an array with items for the transactions parameter.");
			});

			it("Should throw an error if empty array passed in", () => {
				return expect(callType.func(dynamoose.transaction)([])).to.be.rejectedWith("You must pass in an array with items for the transactions parameter.");
			});

			it("Should return request if return setting is set to request", () => {
				return expect(callType.func(dynamoose.transaction)([{"Get": {"Key": {"id": {"N": "1"}}, "TableName": "User"}}], {"return": "request"})).to.eventually.eql({
					"TransactItems": [
						{
							"Get": {
								"Key": {
									"id": {"N": "1"}
								},
								"TableName": "User"
							}
						}
					]
				});
			});

			it("Should throw error if invalid custom type passed in", () => {
				return expect(callType.func(dynamoose.transaction)([{"Get": {"Key": {"id": {"N": "1"}}, "TableName": "User"}}], {"type": "random"})).to.be.rejectedWith("Invalid type option, please pass in \"get\" or \"write\".");
			});

			it("Should throw error if model hasn't been created", () => {
				dynamoose.model("User", {"id": Number, "name": String});
				return expect(callType.func(dynamoose.transaction)([{"Get": {"Key": {"id": {"N": "1"}}, "TableName": "User"}}, {"Get": {"Key": {"id": {"N": "2"}}, "TableName": "Credit"}}])).to.be.rejectedWith("Model \"Credit\" not found. Please register the model with dynamoose before using it in transactions.");
			});

			it("Should send correct parameters to AWS", async () => {
				let transactParams = {};
				dynamoose.aws.ddb.set({
					"transactGetItems": (params) => {
						transactParams = params;
						return {
							"promise": () => Promise.resolve({})
						};
					}
				});

				const User = dynamoose.model("User", {"id": Number, "name": String});
				const Credit = dynamoose.model("Credit", {"id": Number, "name": String});
				new dynamoose.Table("Table", [User, Credit]);
				await callType.func(dynamoose.transaction)([{"Get": {"Key": {"id": {"N": "1"}}, "TableName": "User"}}, {"Get": {"Key": {"id": {"N": "2"}}, "TableName": "Credit"}}]);
				expect(transactParams).to.eql({
					"TransactItems": [
						{
							"Get": {
								"Key": {
									"id": {"N": "1"}
								},
								"TableName": "User"
							}
						},
						{
							"Get": {
								"Key": {
									"id": {"N": "2"}
								},
								"TableName": "Credit"
							}
						}
					]
				});
			});

			it("Should send correct parameters to AWS for put items", async () => {
				let transactParams = {};
				dynamoose.aws.ddb.set({
					"transactWriteItems": (params) => {
						transactParams = params;
						return {
							"promise": () => Promise.resolve({})
						};
					}
				});

				const User = dynamoose.model("User", {"id": Number, "name": String});
				const Credit = dynamoose.model("Credit", {"id": Number, "name": String});
				new dynamoose.Table("Table", [User, Credit]);
				await callType.func(dynamoose.transaction)([{"Put": {"Key": {"id": {"N": "1"}}, "TableName": "User"}}, {"Put": {"Key": {"id": {"N": "2"}}, "TableName": "Credit"}}]);
				expect(transactParams).to.eql({
					"TransactItems": [
						{
							"Put": {
								"Key": {
									"id": {"N": "1"}
								},
								"TableName": "User"
							}
						},
						{
							"Put": {
								"Key": {
									"id": {"N": "2"}
								},
								"TableName": "Credit"
							}
						}
					]
				});
			});

			it("Should use correct response from AWS", () => {
				dynamoose.aws.ddb.set({
					"transactGetItems": () => ({
						"promise": () => Promise.resolve({"Responses": [{"Item": {"id": {"N": "1"}, "name": {"S": "Bob"}}}, {"Item": {"id": {"N": "2"}, "name": {"S": "My Credit"}}}]})
					})
				});

				const User = dynamoose.model("User", {"id": Number, "name": String});
				const Credit = dynamoose.model("Credit", {"id": Number, "name": String});
				new dynamoose.Table("Table", [User, Credit]);
				return expect(callType.func(dynamoose.transaction)([{"Get": {"Key": {"id": {"N": "1"}}, "TableName": "User"}}, {"Get": {"Key": {"id": {"N": "2"}}, "TableName": "Credit"}}]).then((res) => res.map((a) => ({...a})))).to.eventually.eql([
					{"id": 1, "name": "Bob"},
					{"id": 2, "name": "My Credit"}
				]);
			});

			it("Should return null if no response from AWS", () => {
				dynamoose.aws.ddb.set({
					"transactGetItems": () => ({
						"promise": () => Promise.resolve({})
					})
				});

				const User = dynamoose.model("User", {"id": Number, "name": String});
				const Credit = dynamoose.model("Credit", {"id": Number, "name": String});
				new dynamoose.Table("Table", [User, Credit]);
				return expect(callType.func(dynamoose.transaction)([{"Get": {"Key": {"id": {"N": "1"}}, "TableName": "User"}}, {"Get": {"Key": {"id": {"N": "2"}}, "TableName": "Credit"}}])).to.eventually.eql(null);
			});

			it("Should send correct parameters to AWS for custom type of write", async () => {
				let transactParams = {};
				dynamoose.aws.ddb.set({
					"transactWriteItems": (params) => {
						transactParams = params;
						return {
							"promise": () => Promise.resolve({})
						};
					}
				});

				const User = dynamoose.model("User", {"id": Number, "name": String});
				const Credit = dynamoose.model("Credit", {"id": Number, "name": String});
				new dynamoose.Table("Table", [User, Credit]);
				await callType.func(dynamoose.transaction)([{"Put": {"Key": {"id": {"N": "1"}}, "TableName": "User"}}, {"Put": {"Key": {"id": {"N": "2"}}, "TableName": "Credit"}}], {"type": "write"});
				expect(transactParams).to.be.an("object");
			});

			it("Should send correct parameters to AWS for custom type of get", async () => {
				let transactParams = {};
				dynamoose.aws.ddb.set({
					"transactGetItems": (params) => {
						transactParams = params;
						return {
							"promise": () => Promise.resolve({})
						};
					}
				});

				const User = dynamoose.model("User", {"id": Number, "name": String});
				const Credit = dynamoose.model("Credit", {"id": Number, "name": String});
				new dynamoose.Table("Table", [User, Credit]);
				await callType.func(dynamoose.transaction)([{"Put": {"Key": {"id": {"N": "1"}}, "TableName": "User"}}, {"Put": {"Key": {"id": {"N": "2"}}, "TableName": "Credit"}}], {"type": "get"});
				expect(transactParams).to.be.an("object");
			});
		});
	});
});
