const chaiAsPromised = require("chai-as-promised");
const chai = require("chai");
chai.use(chaiAsPromised);
const {expect} = chai;
const dynamoose = require("../../dist");
const Error = require("../../dist/Error");
const Internal = require("../../dist/Internal");
const utils = require("../../dist/utils");
const util = require("util");
const ModelStore = require("../../dist/ModelStore");

describe("Model", () => {
	beforeEach(() => {
		dynamoose.model.defaults.set({"create": false, "waitForActive": false});
	});
	afterEach(() => {
		dynamoose.model.defaults.set({});
	});

	it("Should have a model proprety on the dynamoose object", () => {
		expect(dynamoose.model).to.exist;
	});

	it("Should be a function", () => {
		expect(dynamoose.model).to.be.a("function");
	});

	describe("Initialization", () => {
		it("Should throw an error if no schema is passed in and no existing model in store", () => {
			expect(() => dynamoose.model("Cat")).to.throw(Error.MissingSchemaError);
			expect(() => dynamoose.model("Cat")).to.throw("Schema hasn't been registered for model \"Cat\".\nUse \"dynamoose.model(name, schema)\"");
		});

		it("Should throw same error as no schema if nothing passed in", () => {
			expect(() => dynamoose.model()).to.throw(Error.MissingSchemaError);
			expect(() => dynamoose.model()).to.throw("Schema hasn't been registered for model \"undefined\".\nUse \"dynamoose.model(name, schema)\"");
		});

		it("Should return existing model if already exists and not passing in schema", () => {
			const User = dynamoose.model("User", {"id": String});
			const UserB = dynamoose.model("User");

			expect(UserB).to.eql(User);
		});

		it("Should return existing model if already exists and not passing in schema with default prefix", () => {
			dynamoose.model.defaults.set({"prefix": "test_", "create": false, "waitForActive": false});

			const User = dynamoose.model("User", {"id": String});
			const UserB = dynamoose.model("User");

			expect(UserB).to.eql(User);
		});

		it("Should return existing model if already exists and not passing in schema with prefix in first model", () => {
			const User = dynamoose.model("User", {"id": String}, {"prefix": "test_"});
			const UserB = dynamoose.model("test_User");

			expect(UserB).to.eql(User);
		});

		it("Should store latest model in model store", () => {
			dynamoose.model("User", {"id": String});
			dynamoose.model("User", {"id": String, "name": String});

			expect(ModelStore("User").schemas[0].schemaObject).to.eql({"id": String, "name": String});
		});

		it("Should throw error if passing in empty array for schema parameter", () => {
			expect(() => dynamoose.model("User", [])).to.throw("Schema hasn't been registered for model \"User\".\nUse \"dynamoose.model(name, schema)\"");
		});

		it("Should throw error if hashKey's don't match for all schema's", () => {
			expect(() => dynamoose.model("User", [{"id": String}, {"id2": String}])).to.throw("hashKey's for all schema's must match.");
		});

		it("Should throw error if rangeKey's don't match for all schema's", () => {
			expect(() => dynamoose.model("User", [{"id": String, "rangeKey": {"type": String, "rangeKey": true}}, {"id": String, "rangeKey2": {"type": String, "rangeKey": true}}])).to.throw("rangeKey's for all schema's must match.");
		});

		it("Should create a schema if not passing in schema instance", () => {
			const schema = {"name": String};
			const Cat = dynamoose.model("Cat", schema);
			expect(Cat.Model.schemas).to.not.eql([schema]);
			expect(Cat.Model.schemas[0]).to.be.an.instanceof(dynamoose.Schema);
		});

		it("Should use schema instance if passed in", () => {
			const schema = new dynamoose.Schema({"name": String});
			const Cat = dynamoose.model("Cat", schema);
			expect(Cat.Model.schemas).to.eql([schema]);
			expect(Cat.Model.schemas[0]).to.be.an.instanceof(dynamoose.Schema);
		});

		it("Should not fail with initialization if table doesn't exist", async () => {
			dynamoose.model.defaults.set({});
			const itemsCalled = [];
			dynamoose.aws.ddb.set({
				"createTable": () => {
					return {
						"promise": () => new Promise((resolve) => {
							itemsCalled.push("createTable");
							setTimeout(() => {
								itemsCalled.push("createTableDone");
								resolve();
							}, 100);
						})
					};
				},
				"describeTable": () => ({"promise": () => {
					itemsCalled.push("describeTable");
					return itemsCalled.includes("createTableDone") ? Promise.resolve({"Table": {"TableStatus": "ACTIVE"}}) : Promise.reject();
				}})
			});

			const tableName = "Cat";
			let failed = false;
			const errorHandler = () => {
				failed = true;
			};
			process.on("unhandledRejection", errorHandler);
			dynamoose.model(tableName, {"id": String});
			await utils.timeout(100);
			expect(failed).to.be.false;
			process.removeListener("unhandledRejection", errorHandler);
		});

		// Prefixes & Suffixes
		const optionsB = [
			{"name": "Prefix", "value": "prefix", "check": (val, result) => expect(result).to.match(new RegExp(`^${val}`))},
			{"name": "Suffix", "value": "suffix", "check": (val, result) => expect(result).to.match(new RegExp(`${val}$`))}
		];
		const optionsC = [
			{"name": "Defaults", "func": (type, value, ...args) => {
				dynamoose.model.defaults.set({...dynamoose.model.defaults.get(), [type]: value});
				return dynamoose.model(...args);
			}},
			{"name": "Options", "func": (type, value, ...args) => dynamoose.model(...args, {[type]: value})}
		];
		optionsB.forEach((optionB) => {
			describe(optionB.name, () => {
				optionsC.forEach((optionC) => {
					describe(optionC.name, () => {
						it("Should result in correct model name", () => {
							const extension = "MyApp";
							const tableName = "Users";
							const model = optionC.func(optionB.value, extension, tableName, {"id": String});
							expect(model.Model.name).to.include(extension);
							expect(model.Model.name).to.not.eql(tableName);
						});
					});
				});
			});
		});

		describe("Model.ready", () => {
			it("Should not be ready to start", () => {
				expect(dynamoose.model("Cat", {"id": String}, {"create": false}).Model.ready).to.be.false;
			});

			it("Should set ready after setup flow", async () => {
				const model = dynamoose.model("Cat", {"id": String}, {"create": false});
				await utils.set_immediate_promise();
				expect(model.Model.ready).to.be.true;
			});

			it("Should resolve pendingTaskPromises after model is ready", async () => {
				let describeTableResponse = {
					"Table": {"TableStatus": "CREATING"}
				};
				dynamoose.aws.ddb.set({
					"describeTable": () => ({
						"promise": () => Promise.resolve(describeTableResponse)
					})
				});
				const model = dynamoose.model("Cat", {"id": String}, {"waitForActive": {"enabled": true, "check": {"frequency": 0}}});
				await utils.set_immediate_promise();

				let pendingTaskPromiseResolved = false;
				model.Model.pendingTaskPromise().then(() => pendingTaskPromiseResolved = true);

				await utils.set_immediate_promise();
				expect(pendingTaskPromiseResolved).to.be.false;

				describeTableResponse = {
					"Table": {"TableStatus": "ACTIVE"}
				};
				await model.Model.pendingTaskPromise();
				await utils.set_immediate_promise();
				expect(pendingTaskPromiseResolved).to.be.true;
				expect(model.Model.pendingTasks).to.eql([]);
			});

			it("Should immediately resolve pendingTaskPromises promise if table is already ready", async () => {
				const model = dynamoose.model("Cat", {"id": String}, {"create": false});
				await utils.set_immediate_promise();

				let pendingTaskPromiseResolved = false;
				model.Model.pendingTaskPromise().then(() => pendingTaskPromiseResolved = true);

				await utils.set_immediate_promise();

				expect(pendingTaskPromiseResolved).to.be.true;
			});
		});

		describe("Creation", () => {
			let createTableParams = null;
			beforeEach(() => {
				dynamoose.model.defaults.set({
					"waitForActive": false
				});
			});
			beforeEach(() => {
				createTableParams = null;
				dynamoose.aws.ddb.set({
					"createTable": (params) => {
						createTableParams = params;
						return {
							"promise": () => Promise.resolve()
						};
					},
					"describeTable": () => ({"promise": () => Promise.resolve()})
				});
			});
			afterEach(() => {
				createTableParams = null;
				dynamoose.aws.ddb.revert();
			});

			it("Should call createTable with correct parameters", async () => {
				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String});
				await utils.set_immediate_promise();
				expect(createTableParams).to.eql({
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"ProvisionedThroughput": {
						"ReadCapacityUnits": 1,
						"WriteCapacityUnits": 1
					},
					"TableName": tableName
				});
			});

			it("Should call createTable with correct parameters with capacity as number", async () => {
				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String}, {"throughput": 1});
				await utils.set_immediate_promise();
				expect(createTableParams).to.eql({
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"ProvisionedThroughput": {
						"ReadCapacityUnits": 1,
						"WriteCapacityUnits": 1
					},
					"TableName": tableName
				});
			});

			it("Should call createTable with correct parameters with capacity as object", async () => {
				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String}, {"throughput": {"read": 2, "write": 3}});
				await utils.set_immediate_promise();
				expect(createTableParams).to.eql({
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"ProvisionedThroughput": {
						"ReadCapacityUnits": 2,
						"WriteCapacityUnits": 3
					},
					"TableName": tableName
				});
			});

			it("Should call createTable with correct parameters with capacity as ON_DEMAND", async () => {
				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String}, {"throughput": "ON_DEMAND"});
				await utils.set_immediate_promise();
				expect(createTableParams).to.eql({
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"BillingMode": "PAY_PER_REQUEST",
					"TableName": tableName
				});
			});

			it("Shouldn't call createTable if table already exists", async () => {
				dynamoose.aws.ddb.set({
					"createTable": (params) => {
						createTableParams = params;
						return {
							"promise": () => Promise.resolve()
						};
					},
					"describeTable": () => ({"promise": () => Promise.resolve({"Table": {"TableStatus": "ACTIVE"}})})
				});

				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String});
				await utils.set_immediate_promise();
				expect(createTableParams).to.eql(null);
			});

			it("Should not call createTable if create option set to false", async () => {
				dynamoose.model("Cat", {"id": String}, {"create": false});
				await utils.set_immediate_promise();
				expect(createTableParams).to.eql(null);
			});

			it("Should bind request to function being called", async () => {
				let self;
				dynamoose.aws.ddb.set({
					"createTable": (params) => {
						createTableParams = params;
						return {
							"promise": function () {
								self = this;
								return Promise.resolve();
							}
						};
					},
					"describeTable": () => ({"promise": () => Promise.resolve()})
				});

				dynamoose.model("Cat", {"id": String});
				await utils.set_immediate_promise();
				expect(self).to.be.an("object");
				expect(Object.keys(self)).to.eql(["promise"]);
				expect(self.promise).to.exist;
			});
		});

		describe("Wait For Active", () => {
			let describeTableParams = [], describeTableFunction, updateTableParams = [];
			beforeEach(() => {
				dynamoose.model.defaults.set({
					"create": false,
					"waitForActive": {
						"enabled": true,
						"check": {
							"timeout": 10,
							"frequency": 1
						}
					}
				});
			});
			beforeEach(() => {
				describeTableParams = [];
				updateTableParams = [];
				dynamoose.aws.ddb.set({
					"describeTable": (params) => {
						describeTableParams.push(params);
						return {
							"promise": () => describeTableFunction(params)
						};
					},
					"updateTable": (params) => {
						updateTableParams.push(params);
						return {
							"promise": () => Promise.resolve()
						};
					}
				});
			});
			afterEach(() => {
				describeTableParams = [];
				updateTableParams = [];
				describeTableFunction = null;
				dynamoose.aws.ddb.revert();
			});

			it("Should call describeTable with correct parameters", async () => {
				const tableName = "Cat";
				describeTableFunction = () => Promise.resolve({
					"Table": {
						"TableStatus": "ACTIVE"
					}
				});
				dynamoose.model(tableName, {"id": String});
				await utils.set_immediate_promise();
				expect(describeTableParams).to.eql([{
					"TableName": tableName
				}]);
			});

			it("Should call describeTable with correct parameters multiple times", async () => {
				const tableName = "Cat";
				describeTableFunction = () => Promise.resolve({
					"Table": {
						"TableStatus": describeTableParams.length > 1 ? "ACTIVE" : "CREATING"
					}
				});
				dynamoose.model(tableName, {"id": String});
				await utils.timeout(5);
				expect(describeTableParams).to.eql([{
					"TableName": tableName
				}, {
					"TableName": tableName
				}]);
			});

			it("Should timeout according to waitForActive timeout rules", async () => {
				const tableName = "Cat";
				describeTableFunction = () => Promise.resolve({
					"Table": {
						"TableStatus": "CREATING"
					}
				});
				dynamoose.model(tableName, {"id": String});
				const errorHandler = utils.empty_function;
				process.on("unhandledRejection", errorHandler);
				await utils.timeout(15);
				expect(describeTableParams.length).to.be.above(5);
				process.removeListener("unhandledRejection", errorHandler);
			});

			it("Should throw error if AWS throws error", async () => {
				const tableName = "Cat";
				describeTableFunction = () => Promise.reject({"error": "ERROR"});

				let error;
				dynamoose.model(tableName, {"id": String});
				const errorHandler = (err) => error = err;
				process.on("unhandledRejection", errorHandler);
				await utils.timeout(15);
				expect(error).to.eql({"error": "ERROR"});
				process.removeListener("unhandledRejection", errorHandler);
			});

			it("Should not call describeTable if table already created and already attempted to createTable again", async () => {
				const tableName = "Cat";
				describeTableFunction = () => {
					return Promise.resolve({"Table": {"TableStatus": "ACTIVE"}});
				};

				dynamoose.model(tableName, {"id": String}, {"create": true});
				await utils.timeout(5);
				expect(describeTableParams).to.eql([{
					"TableName": tableName
				}]);
			});

			it("Should call updateTable even if table is still being created when waitForActive is set to false", async () => {
				const tableName = "Cat";
				describeTableFunction = () => Promise.resolve({
					"Table": {
						"ProvisionedThroughput": {
							"ReadCapacityUnits": 2,
							"WriteCapacityUnits": 2
						},
						"TableStatus": "CREATING"
					}
				});
				dynamoose.model(tableName, {"id": String}, {"throughput": {"read": 1, "write": 2}, "update": true, "waitForActive": false});
				await utils.set_immediate_promise();
				expect(updateTableParams).to.eql([{
					"ProvisionedThroughput": {
						"ReadCapacityUnits": 1,
						"WriteCapacityUnits": 2
					},
					"TableName": tableName
				}]);
			});

			it("Should not call updateTable when table is still being created when waitForActive is set to true", async () => {
				const tableName = "Cat";
				describeTableFunction = () => Promise.resolve({
					"Table": {
						"ProvisionedThroughput": {
							"ReadCapacityUnits": 2,
							"WriteCapacityUnits": 2
						},
						"TableStatus": "CREATING"
					}
				});
				dynamoose.model(tableName, {"id": String}, {"throughput": {"read": 1, "write": 2}, "update": true, "waitForActive": true});
				await utils.set_immediate_promise();
				expect(updateTableParams).to.eql([]);
			});
		});

		describe("Update", () => {
			let describeTableFunction, updateTableParams = [];
			beforeEach(() => {
				dynamoose.model.defaults.set({
					"create": false,
					"update": true
				});
			});
			beforeEach(() => {
				updateTableParams = [];
				dynamoose.aws.ddb.set({
					"describeTable": () => {
						return {
							"promise": describeTableFunction
						};
					},
					"updateTable": (params) => {
						updateTableParams.push(params);
						return {
							"promise": () => Promise.resolve()
						};
					}
				});
			});
			afterEach(() => {
				updateTableParams = [];
				describeTableFunction = null;
				dynamoose.aws.ddb.revert();
			});

			describe("Throughput", () => {
				const updateOptions = [
					true,
					["throughput"]
				];
				updateOptions.forEach((updateOption) => {
					describe(`{"update": ${JSON.stringify(updateOption)}}`, () => {
						it("Should not call updateTable if throughput matches", async () => {
							const tableName = "Cat";
							describeTableFunction = () => Promise.resolve({
								"Table": {
									"ProvisionedThroughput": {
										"ReadCapacityUnits": 1,
										"WriteCapacityUnits": 2
									},
									"TableStatus": "ACTIVE"
								}
							});
							dynamoose.model(tableName, {"id": String}, {"throughput": {"read": 1, "write": 2}, "update": updateOption});
							await utils.set_immediate_promise();
							expect(updateTableParams).to.eql([]);
						});

						it("Should call updateTable with correct parameters if throughput doesn't match", async () => {
							const tableName = "Cat";
							describeTableFunction = () => Promise.resolve({
								"Table": {
									"ProvisionedThroughput": {
										"ReadCapacityUnits": 2,
										"WriteCapacityUnits": 2
									},
									"TableStatus": "ACTIVE"
								}
							});
							dynamoose.model(tableName, {"id": String}, {"throughput": {"read": 1, "write": 2}, "update": updateOption});
							await utils.set_immediate_promise();
							expect(updateTableParams).to.eql([{
								"ProvisionedThroughput": {
									"ReadCapacityUnits": 1,
									"WriteCapacityUnits": 2
								},
								"TableName": tableName
							}]);
						});

						it("Should call updateTable with correct parameters if switching from provisioned to on demand", async () => {
							const tableName = "Cat";
							describeTableFunction = () => Promise.resolve({
								"Table": {
									"ProvisionedThroughput": {
										"ReadCapacityUnits": 2,
										"WriteCapacityUnits": 2
									},
									"TableStatus": "ACTIVE"
								}
							});
							dynamoose.model(tableName, {"id": String}, {"throughput": "ON_DEMAND", "update": updateOption});
							await utils.set_immediate_promise();
							expect(updateTableParams).to.eql([{
								"BillingMode": "PAY_PER_REQUEST",
								"TableName": tableName
							}]);
						});

						it("Should call updateTable with correct parameters if switching from on demand to provisioned", async () => {
							const tableName = "Cat";
							describeTableFunction = () => Promise.resolve({
								"Table": {
									"BillingMode": "PAY_PER_REQUEST",
									"TableStatus": "ACTIVE"
								}
							});
							dynamoose.model(tableName, {"id": String}, {"throughput": 5, "update": updateOption});
							await utils.set_immediate_promise();
							expect(updateTableParams).to.eql([{
								"ProvisionedThroughput": {
									"ReadCapacityUnits": 5,
									"WriteCapacityUnits": 5
								},
								"TableName": tableName
							}]);
						});
					});
				});
			});

			describe("Indexes", () => {
				const updateOptions = [
					true,
					["indexes"]
				];
				updateOptions.forEach((updateOption) => {
					describe(`{"update": ${JSON.stringify(updateOption)}}`, () => {
						it("Should call updateTable to add index", async () => {
							const tableName = "Cat";
							describeTableFunction = () => Promise.resolve({
								"Table": {
									"ProvisionedThroughput": {
										"ReadCapacityUnits": 1,
										"WriteCapacityUnits": 1
									},
									"TableStatus": "ACTIVE"
								}
							});
							const model = dynamoose.model(tableName, {"id": String, "name": {"type": String, "index": {"global": true}}}, {"update": updateOption});
							await model.Model.pendingTaskPromise();
							await utils.set_immediate_promise();
							expect(updateTableParams).to.eql([
								{
									"AttributeDefinitions": [
										{
											"AttributeName": "id",
											"AttributeType": "S"
										},
										{
											"AttributeName": "name",
											"AttributeType": "S"
										}
									],
									"GlobalSecondaryIndexUpdates": [
										{
											"Create": {
												"IndexName": "nameGlobalIndex",
												"KeySchema": [
													{
														"AttributeName": "name",
														"KeyType": "HASH"
													}
												],
												"Projection": {
													"ProjectionType": "ALL"
												},
												"ProvisionedThroughput": {
													"ReadCapacityUnits": 1,
													"WriteCapacityUnits": 1
												}
											}
										}
									],
									"TableName": "Cat"
								}
							]);
						});

						it("Should call updateTable to delete index", async () => {
							const tableName = "Cat";
							describeTableFunction = () => Promise.resolve({
								"Table": {
									"ProvisionedThroughput": {
										"ReadCapacityUnits": 1,
										"WriteCapacityUnits": 1
									},
									"TableStatus": "ACTIVE",
									"AttributeDefinitions": [
										{
											"AttributeName": "id",
											"AttributeType": "S"
										},
										{
											"AttributeName": "name",
											"AttributeType": "S"
										}
									],
									"GlobalSecondaryIndexes": [
										{
											"IndexName": "nameGlobalIndex",
											"IndexStatus": "ACTIVE",
											"KeySchema": [
												{
													"AttributeName": "name",
													"KeyType": "HASH"
												}
											],
											"Projection": {
												"ProjectionType": "ALL"
											},
											"ProvisionedThroughput": {
												"ReadCapacityUnits": 1,
												"WriteCapacityUnits": 1
											}
										}
									]
								}
							});
							const model = dynamoose.model(tableName, {"id": String, "name": {"type": String}}, {"update": updateOption});
							await model.Model.pendingTaskPromise();
							await utils.set_immediate_promise();
							expect(updateTableParams).to.eql([
								{
									"GlobalSecondaryIndexUpdates": [
										{
											"Delete": {
												"IndexName": "nameGlobalIndex"
											}
										}
									],
									"TableName": "Cat"
								}
							]);
						});

						it("Should call updateTable to add multiple indexes correctly", async () => {
							const tableName = "Cat";
							let describeTableFunctionCalledTimes = 0;
							let testUpdateTableParams = {};
							describeTableFunction = () => {
								++describeTableFunctionCalledTimes;
								let obj;
								if (describeTableFunctionCalledTimes === 1) {
									obj = {
										"Table": {
											"ProvisionedThroughput": {
												"ReadCapacityUnits": 1,
												"WriteCapacityUnits": 1
											},
											"TableStatus": "ACTIVE"
										}
									};
								} else if (describeTableFunctionCalledTimes === 2) {
									testUpdateTableParams["0"] = [...updateTableParams];
									obj = {
										"Table": {
											"ProvisionedThroughput": {
												"ReadCapacityUnits": 1,
												"WriteCapacityUnits": 1
											},
											"TableStatus": "ACTIVE",
											"GlobalSecondaryIndexes": [
												{
													"IndexName": "nameGlobalIndex",
													"IndexStatus": "CREATING",
													"KeySchema": [
														{
															"AttributeName": "name",
															"KeyType": "HASH"
														}
													],
													"Projection": {
														"ProjectionType": "ALL"
													},
													"ProvisionedThroughput": {
														"ReadCapacityUnits": 1,
														"WriteCapacityUnits": 1
													}
												}
											]
										}
									};
								} else if (describeTableFunctionCalledTimes === 3) {
									obj = {
										"Table": {
											"ProvisionedThroughput": {
												"ReadCapacityUnits": 1,
												"WriteCapacityUnits": 1
											},
											"TableStatus": "ACTIVE",
											"GlobalSecondaryIndexes": [
												{
													"IndexName": "nameGlobalIndex",
													"IndexStatus": "ACTIVE",
													"KeySchema": [
														{
															"AttributeName": "name",
															"KeyType": "HASH"
														}
													],
													"Projection": {
														"ProjectionType": "ALL"
													},
													"ProvisionedThroughput": {
														"ReadCapacityUnits": 1,
														"WriteCapacityUnits": 1
													}
												}
											]
										}
									};
								} else if (describeTableFunctionCalledTimes === 4) {
									testUpdateTableParams["1"] = [...updateTableParams];
									obj = {
										"Table": {
											"ProvisionedThroughput": {
												"ReadCapacityUnits": 1,
												"WriteCapacityUnits": 1
											},
											"TableStatus": "ACTIVE",
											"GlobalSecondaryIndexes": [
												{
													"IndexName": "nameGlobalIndex",
													"IndexStatus": "ACTIVE",
													"KeySchema": [
														{
															"AttributeName": "name",
															"KeyType": "HASH"
														}
													],
													"Projection": {
														"ProjectionType": "ALL"
													},
													"ProvisionedThroughput": {
														"ReadCapacityUnits": 1,
														"WriteCapacityUnits": 1
													}
												},
												{
													"IndexName": "statusGlobalIndex",
													"IndexStatus": "CREATING",
													"KeySchema": [
														{
															"AttributeName": "status",
															"KeyType": "HASH"
														}
													],
													"Projection": {
														"ProjectionType": "ALL"
													},
													"ProvisionedThroughput": {
														"ReadCapacityUnits": 1,
														"WriteCapacityUnits": 1
													}
												}
											]
										}
									};
								} else if (describeTableFunctionCalledTimes >= 4) {
									obj = {
										"Table": {
											"ProvisionedThroughput": {
												"ReadCapacityUnits": 1,
												"WriteCapacityUnits": 1
											},
											"TableStatus": "ACTIVE",
											"GlobalSecondaryIndexes": [
												{
													"IndexName": "nameGlobalIndex",
													"IndexStatus": "ACTIVE",
													"KeySchema": [
														{
															"AttributeName": "name",
															"KeyType": "HASH"
														}
													],
													"Projection": {
														"ProjectionType": "ALL"
													},
													"ProvisionedThroughput": {
														"ReadCapacityUnits": 1,
														"WriteCapacityUnits": 1
													}
												},
												{
													"IndexName": "statusGlobalIndex",
													"IndexStatus": "ACTIVE",
													"KeySchema": [
														{
															"AttributeName": "status",
															"KeyType": "HASH"
														}
													],
													"Projection": {
														"ProjectionType": "ALL"
													},
													"ProvisionedThroughput": {
														"ReadCapacityUnits": 1,
														"WriteCapacityUnits": 1
													}
												}
											]
										}
									};
								}
								return Promise.resolve(obj);
							};
							const model = dynamoose.model(tableName, {"id": String, "name": {"type": String, "index": {"global": true}}, "status": {"type": String, "index": {"global": true}}}, {"update": updateOption});
							await model.Model.pendingTaskPromise();
							await utils.set_immediate_promise();
							expect(describeTableFunctionCalledTimes).to.eql(5);
							expect(utils.array_flatten(testUpdateTableParams["0"].map((a) => a.GlobalSecondaryIndexUpdates))).to.eql([{
								"Create": {
									"IndexName": "nameGlobalIndex",
									"KeySchema": [
										{
											"AttributeName": "name",
											"KeyType": "HASH"
										}
									],
									"Projection": {
										"ProjectionType": "ALL"
									},
									"ProvisionedThroughput": {
										"ReadCapacityUnits": 1,
										"WriteCapacityUnits": 1
									}
								}
							}]);
							expect(utils.array_flatten(testUpdateTableParams["1"].map((a) => a.GlobalSecondaryIndexUpdates))).to.eql([
								...testUpdateTableParams["0"][0].GlobalSecondaryIndexUpdates,
								{
									"Create": {
										"IndexName": "statusGlobalIndex",
										"KeySchema": [
											{
												"AttributeName": "status",
												"KeyType": "HASH"
											}
										],
										"Projection": {
											"ProjectionType": "ALL"
										},
										"ProvisionedThroughput": {
											"ReadCapacityUnits": 1,
											"WriteCapacityUnits": 1
										}
									}
								}
							]);
						});
					});
				});
			});
		});

		describe("Time To Live", () => {
			let updateTTLParams = [], describeTTL, describeTTLFunction;
			beforeEach(() => {
				dynamoose.model.defaults.set({
					"create": false,
					"update": true
				});
			});
			beforeEach(() => {
				updateTTLParams = [];
				dynamoose.aws.ddb.set({
					"describeTable": () => {
						return {
							"promise": () => Promise.resolve({
								"Table": {
									"ProvisionedThroughput": {
										"ReadCapacityUnits": 1,
										"WriteCapacityUnits": 1
									},
									"TableStatus": "ACTIVE"
								}
							})
						};
					},
					"updateTimeToLive": (params) => {
						updateTTLParams.push(params);
						return {
							"promise": () => Promise.resolve()
						};
					},
					"describeTimeToLive": () => {
						return describeTTLFunction ? describeTTLFunction() : {
							"promise": () => Promise.resolve(describeTTL)
						};
					}
				});
			});
			afterEach(() => {
				updateTTLParams = [];
				describeTTL = null;
				describeTTLFunction = null;
				dynamoose.aws.ddb.revert();
			});

			it("Should call updateTimeToLive with correct parameters if TTL is disabled", async () => {
				describeTTL = {"TimeToLiveDescription": {"TimeToLiveStatus": "DISABLED"}};
				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String}, {"expires": 1000});
				await utils.set_immediate_promise();
				expect(updateTTLParams).to.eql([{
					"TableName": tableName,
					"TimeToLiveSpecification": {
						"Enabled": true,
						"AttributeName": "ttl"
					}
				}]);
			});

			it("Should not call updateTimeToLive with correct parameters if TTL is enabled", async () => {
				describeTTL = {"TimeToLiveDescription": {"TimeToLiveStatus": "ENABLED"}};
				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String}, {"expires": 1000});
				await utils.set_immediate_promise();
				expect(updateTTLParams).to.eql([]);
			});

			it("Should not call updateTimeToLive with correct parameters if TTL is enabling", async () => {
				describeTTL = {"TimeToLiveDescription": {"TimeToLiveStatus": "ENABLING"}};
				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String}, {"expires": 1000});
				await utils.set_immediate_promise();
				expect(updateTTLParams).to.eql([]);
			});

			it("Should call updateTimeToLive with correct parameters for custom attribute if TTL is disabling", async () => {
				const startTime = Date.now();
				let timesCalledDescribeTTL = 0;
				describeTTLFunction = () => {
					return {
						"promise": async () => {
							timesCalledDescribeTTL++;
							return Promise.resolve(timesCalledDescribeTTL < 2 ? {"TimeToLiveDescription": {"TimeToLiveStatus": "DISABLING"}} : {"TimeToLiveDescription": {"TimeToLiveStatus": "DISABLED"}});
						}
					};
				};
				const tableName = "Cat";
				const model = dynamoose.model(tableName, {"id": String}, {"expires": {"ttl": 1000, "attribute": "expires"}});
				await model.Model.pendingTaskPromise();
				expect(updateTTLParams).to.eql([{
					"TableName": tableName,
					"TimeToLiveSpecification": {
						"Enabled": true,
						"AttributeName": "expires"
					}
				}]);
				expect(timesCalledDescribeTTL).to.eql(2);
				expect(Date.now() - startTime).to.be.at.least(1000);
			});

			it("Should call updateTimeToLive with correct parameters for custom attribute if TTL is disabled", async () => {
				describeTTL = {"TimeToLiveDescription": {"TimeToLiveStatus": "DISABLED"}};
				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String}, {"expires": {"ttl": 1000, "attribute": "expires"}});
				await utils.set_immediate_promise();
				expect(updateTTLParams).to.eql([{
					"TableName": tableName,
					"TimeToLiveSpecification": {
						"Enabled": true,
						"AttributeName": "expires"
					}
				}]);
			});

			it("Should not call updateTimeToLive if no expires", async () => {
				const tableName = "Cat";
				dynamoose.model(tableName, {"id": String});
				await utils.set_immediate_promise();
				expect(updateTTLParams).to.eql([]);
			});
		});
	});

	describe("Model.get", () => {
		let User, getItemParams, getItemFunction;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String});
			getItemParams = null;
			getItemFunction = null;
			dynamoose.aws.ddb.set({
				"getItem": (params) => {
					getItemParams = params;
					return {"promise": getItemFunction};
				}
			});
		});
		afterEach(() => {
			User = null;
			getItemParams = null;
			getItemFunction = null;
			dynamoose.aws.ddb.revert();
		});

		it("Should be a function", () => {
			expect(User.get).to.be.a("function");
		});

		const functionCallTypes = [
			{"name": "Promise", "func": (Model) => Model.get},
			{"name": "Callback", "func": (Model) => util.promisify(Model.get)}
		];

		functionCallTypes.forEach((callType) => {
			describe(callType.name, () => {
				it("Should send correct params to getItem", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					await callType.func(User).bind(User)(1);
					expect(getItemParams).to.be.an("object");
					expect(getItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send consistent (false) to getItem", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					await callType.func(User).bind(User)(1, {"consistent": false});
					expect(getItemParams).to.be.an("object");
					expect(getItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ConsistentRead": false
					});
				});

				it("Should send consistent (true) to getItem", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					await callType.func(User).bind(User)(1, {"consistent": true});
					expect(getItemParams).to.be.an("object");
					expect(getItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ConsistentRead": true
					});
				});

				it("Should get consistent (false) back in request", async () => {
					const result = await callType.func(User).bind(User)(1, {"return": "request", "consistent": true});
					expect(getItemParams).to.not.exist;
					expect(result).to.eql({
						"Key": {"id": {"N": "1"}},
						"TableName": "User",
						"ConsistentRead": true
					});
				});

				it("Should get consistent (true) back in request", async () => {
					const result = await callType.func(User).bind(User)(1, {"return": "request", "consistent": false});
					expect(getItemParams).to.not.exist;
					expect(result).to.eql({
						"Key": {"id": {"N": "1"}},
						"TableName": "User",
						"ConsistentRead": false
					});
				});

				it("Should send correct params to getItem if we pass in an object", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					await callType.func(User).bind(User)({"id": 1});
					expect(getItemParams).to.be.an("object");
					expect(getItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to getItem if we only request a certain attribute", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					await callType.func(User).bind(User)({"id": 1}, {"attributes": ["id"]});
					expect(getItemParams).to.be.an("object");
					expect(getItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ProjectionExpression": "#a0",
						"ExpressionAttributeNames": {
							"#a0": "id"
						}
					});
				});

				it("Should send correct params to getItem if we request certain attributes", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					await callType.func(User).bind(User)({"id": 1}, {"attributes": ["id", "name"]});
					expect(getItemParams).to.be.an("object");
					expect(getItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ProjectionExpression": "#a0, #a1",
						"ExpressionAttributeNames": {
							"#a0": "id",
							"#a1": "name"
						}
					});
				});

				it("Should send correct params to getItem if we pass in an object with range key", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "rangeKey": true}});
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(getItemParams).to.be.an("object");
					expect(getItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							},
							"name": {
								"S": "Charlie"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to getItem if we pass in an entire object with unnecessary attributes", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(getItemParams).to.be.an("object");
					expect(getItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User"
					});
				});

				it("Should return object with correct values", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "name"]);
					expect(user.id).to.eql(1);
					expect(user.name).to.eql("Charlie");
				});

				it("Should return object that is an instance of Document", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an.instanceof(User);
				});

				it("Should return request if return request setting is set", async () => {
					const result = await callType.func(User).bind(User)(1, {"return": "request"});
					expect(getItemParams).to.not.exist;
					expect(result).to.eql({
						"Key": {"id": {"N": "1"}},
						"TableName": "User"
					});
				});

				it("Should return undefined for expired object", async () => {
					User = dynamoose.model("User", {"id": Number}, {"expires": {"ttl": 1000, "items": {"returnExpired": false}}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "ttl": {"N": "1"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.eql(undefined);
				});

				it("Should return expired object if returnExpired is not set", async () => {
					User = dynamoose.model("User", {"id": Number}, {"expires": 1000});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "ttl": {"N": "1"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "ttl"]);
					expect(user.id).to.eql(1);
					expect(user.ttl).to.eql(new Date(1000));
				});

				it("Should return object with correct values with saveUnknown", async () => {
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number}, {"saveUnknown": true}));
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "hello": {"S": "world"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "hello"]);
					expect(user.id).to.eql(1);
					expect(user.hello).to.eql("world");
				});

				it("Should return object with correct values for string set", async () => {
					User = dynamoose.model("User", {"id": Number, "friends": {"type": Set, "schema": [String]}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "friends": {"SS": ["Charlie", "Bob"]}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "friends"]);
					expect(user.id).to.eql(1);
					expect(user.friends).to.eql(new Set(["Charlie", "Bob"]));
				});

				it("Should return object with correct values for string set with saveUnknown", async () => {
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number}, {"saveUnknown": true}));
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "friends": {"SS": ["Charlie", "Bob"]}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "friends"]);
					expect(user.id).to.eql(1);
					expect(user.friends).to.eql(new Set(["Charlie", "Bob"]));
				});

				it("Should return object with correct values for number set", async () => {
					User = dynamoose.model("User", {"id": Number, "numbers": {"type": Set, "schema": [Number]}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "numbers": {"NS": ["5", "7"]}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "numbers"]);
					expect(user.id).to.eql(1);
					expect(user.numbers).to.eql(new Set([5, 7]));
				});

				it("Should return object with correct values for number set with saveUnknown", async () => {
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number}, {"saveUnknown": true}));
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "numbers": {"NS": ["5", "7"]}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "numbers"]);
					expect(user.id).to.eql(1);
					expect(user.numbers).to.eql(new Set([5, 7]));
				});

				it("Should return object with correct values for date set", async () => {
					User = dynamoose.model("User", {"id": Number, "times": {"type": Set, "schema": [Date]}});
					const time = new Date();
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "times": {"NS": [time.getTime(), 0]}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "times"]);
					expect(user.id).to.eql(1);
					expect(user.times).to.eql(new Set([time, new Date(0)]));
				});

				it("Should return object with correct values for buffer", async () => {
					User = dynamoose.model("User", {"id": Number, "data": Buffer});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "data": {"B": Buffer.from("testdata")}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "data"]);
					expect(user.id).to.eql(1);
					expect(user.data).to.eql(Buffer.from("testdata"));
				});

				it("Should return object with correct values for buffer set", async () => {
					User = dynamoose.model("User", {"id": Number, "data": {"type": Set, "schema": [Buffer]}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "data": {"BS": [Buffer.from("testdata"), Buffer.from("testdata2")]}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "data"]);
					expect(user.id).to.eql(1);
					expect(user.data).to.eql(new Set([Buffer.from("testdata"), Buffer.from("testdata2")]));
				});

				it("Should return object with correct values for buffer set with saveUnknown", async () => {
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number}, {"saveUnknown": true}));
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "data": {"BS": [Buffer.from("testdata"), Buffer.from("testdata2")]}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "data"]);
					expect(user.id).to.eql(1);
					expect(user.data).to.eql(new Set([Buffer.from("testdata"), Buffer.from("testdata2")]));
				});

				it("Should return object with correct values if using custom types", async () => {
					User = dynamoose.model("User", {"id": Number, "name": String, "birthday": Date});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "birthday": {"N": "1"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "name", "birthday"]);
					expect(user.id).to.eql(1);
					expect(user.name).to.eql("Charlie");
					expect(user.birthday).to.eql(new Date(1));
				});

				it("Should return object with correct values if using custom types but value doesn't exist", async () => {
					User = dynamoose.model("User", {"id": Number, "name": String, "birthday": Date});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "name"]);
					expect(user.id).to.eql(1);
					expect(user.name).to.eql("Charlie");
					expect(user.birthday).to.not.exist;
				});

				it("Should throw type mismatch error if passing in wrong type with custom type", () => {
					User = dynamoose.model("User", {"id": Number, "name": String, "birthday": Date});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "birthday": {"S": "Hello World"}}});

					return expect(callType.func(User).bind(User)(1)).to.be.rejectedWith("Expected birthday to be of type date, instead found type string.");
				});

				it("Should return object with correct values with object property", async () => {
					User = dynamoose.model("User", {"id": Number, "address": {"type": Object, "schema": {"street": String, "country": {"type": String, "required": true}}}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "address": {"M": {"street": {"S": "hello"}, "country": {"S": "world"}}}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "address"]);
					expect(user.id).to.eql(1);
					expect(user.address).to.eql({"street": "hello", "country": "world"});
				});

				it("Should return object with correct values with object property with elements that don't exist in schema", async () => {
					User = dynamoose.model("User", {"id": Number, "address": {"type": Object, "schema": {"street": String, "country": {"type": String, "required": true}}}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "address": {"M": {"zip": {"N": "12345"}, "country": {"S": "world"}}}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "address"]);
					expect(user.id).to.eql(1);
					expect(user.address).to.eql({"country": "world"});
				});

				it("Should throw type mismatch error if passing in wrong type with custom type for object", () => {
					User = dynamoose.model("User", {"id": Number, "address": {"type": Object, "schema": {"street": String, "country": {"type": String, "required": true}}}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "address": {"S": "test"}}});

					return expect(callType.func(User).bind(User)(1)).to.be.rejectedWith("Expected address to be of type object, instead found type string.");
				});

				it("Should throw type mismatch error if passing in wrong type for nested object attribute", () => {
					User = dynamoose.model("User", {"id": Number, "address": {"type": Object, "schema": {"street": String, "country": {"type": String, "required": true}}}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "address": {"M": {"country": {"BOOL": true}}}}});

					return expect(callType.func(User).bind(User)(1)).to.be.rejectedWith("Expected address.country to be of type string, instead found type boolean.");
				});

				it("Should return object with correct values with object property and saveUnknown set to true", async () => {
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "address": Object}, {"saveUnknown": true}));
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "address": {"M": {"zip": {"N": "12345"}, "country": {"S": "world"}}}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "address"]);
					expect(user.id).to.eql(1);
					expect(user.address).to.eql({"country": "world", "zip": 12345});
				});

				it("Should return object with correct values with multiple nested object properties and saveUnknown set to true", async () => {
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "address": Object}, {"saveUnknown": true}));
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "address": {"M": {"data": {"M": {"country": {"S": "world"}}}, "name": {"S": "Home"}}}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "address"]);
					expect(user.id).to.eql(1);
					expect(user.address).to.eql({"data": {"country": "world"}, "name": "Home"});
				});

				it("Should return object with correct values with multiple nested object properties", async () => {
					User = dynamoose.model("User", {"id": Number, "address": {"type": Object, "schema": {"data": {"type": Object, "schema": {"country": String}}, "name": String}}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "address": {"M": {"data": {"M": {"country": {"S": "world"}}}, "name": {"S": "Home"}}}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "address"]);
					expect(user.id).to.eql(1);
					expect(user.address).to.eql({"data": {"country": "world"}, "name": "Home"});
				});

				it("Should return correct object for array properties", async () => {
					User = dynamoose.model("User", {"id": Number, "friends": {"type": Array, "schema": [String]}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "friends": {"L": [{"S": "Tim"}, {"S": "Bob"}]}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "friends"]);
					expect(user.id).to.eql(1);
					expect(user.friends).to.eql(["Tim", "Bob"]);
				});

				it("Should return correct object with array and objects within array", async () => {
					User = dynamoose.model("User", {"id": Number, "friends": {"type": Array, "schema": [{"type": Object, "schema": {"id": Number, "name": String}}]}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "friends": {"L": [{"M": {"name": {"S": "Tim"}, "id": {"N": "1"}}}, {"M": {"name": {"S": "Bob"}, "id": {"N": "2"}}}]}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "friends"]);
					expect(user.id).to.eql(1);
					expect(user.friends).to.eql([{"name": "Tim", "id": 1}, {"name": "Bob", "id": 2}]);
				});

				it("Should return correct object if attribute has a get function", async () => {
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "get": (val) => `${val}-get`}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "name"]);
					expect(user.id).to.eql(1);
					expect(user.name).to.eql("Charlie-get");
				});

				it("Should return correct object if attribute has an async get function", async () => {
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "get": async (val) => `${val}-get`}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "name"]);
					expect(user.id).to.eql(1);
					expect(user.name).to.eql("Charlie-get");
				});

				describe("Populate", () => {
					it("Should not populate document automatically", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": dynamoose.model("Parent", {"id": Number, "data": String})});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"N": "2"}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.toJSON()).to.eql({
							"id": 1,
							"name": "Charlie",
							"parent": 2
						});
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically if schema property is object", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": dynamoose.model("Parent", {"id": Number, "data": String})}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"N": "2"}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.toJSON()).to.eql({
							"id": 1,
							"name": "Charlie",
							"parent": 2
						});
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when schema property is dynamoose.THIS", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": dynamoose.THIS});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"N": "2"}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.toJSON()).to.eql({
							"id": 1,
							"name": "Charlie",
							"parent": 2
						});
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when schema property is dynamoose.THIS if schema property is object", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": dynamoose.THIS}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"N": "2"}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.toJSON()).to.eql({
							"id": 1,
							"name": "Charlie",
							"parent": 2
						});
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when using set", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": Set, "schema": [dynamoose.model("Parent", {"id": Number, "data": String})]}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"NS": ["2"]}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.id).to.eql(1);
						expect(user.name).to.eql("Charlie");
						expect(user.parent).to.eql(new Set([2]));
						expect(Object.keys(user.toJSON())).to.eql(["id", "name", "parent"]);
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when using set if schema property is object", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": Set, "schema": [{"type": dynamoose.model("Parent", {"id": Number, "data": String})}]}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"NS": ["2"]}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.id).to.eql(1);
						expect(user.name).to.eql("Charlie");
						expect(user.parent).to.eql(new Set([2]));
						expect(Object.keys(user.toJSON())).to.eql(["id", "name", "parent"]);
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when using set when schema property is dynamoose.THIS", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": Set, "schema": [dynamoose.THIS]}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"NS": ["2"]}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.id).to.eql(1);
						expect(user.name).to.eql("Charlie");
						expect(user.parent).to.eql(new Set([2]));
						expect(Object.keys(user.toJSON())).to.eql(["id", "name", "parent"]);
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when using set when schema property is dynamoose.THIS if schema property is object", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": Set, "schema": [{"type": dynamoose.THIS}]}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"NS": ["2"]}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.id).to.eql(1);
						expect(user.name).to.eql("Charlie");
						expect(user.parent).to.eql(new Set([2]));
						expect(Object.keys(user.toJSON())).to.eql(["id", "name", "parent"]);
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when using array", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": Array, "schema": [dynamoose.model("Parent", {"id": Number, "data": String})]}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"L": [{"N": "2"}]}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.toJSON()).to.eql({
							"id": 1,
							"name": "Charlie",
							"parent": [2]
						});
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when using array if schema property is object", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": Array, "schema": [{"type": dynamoose.model("Parent", {"id": Number, "data": String})}]}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"L": [{"N": "2"}]}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.toJSON()).to.eql({
							"id": 1,
							"name": "Charlie",
							"parent": [2]
						});
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when using array when schema property is dynamoose.THIS", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": Array, "schema": [dynamoose.THIS]}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"L": [{"N": "2"}]}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.toJSON()).to.eql({
							"id": 1,
							"name": "Charlie",
							"parent": [2]
						});
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should not populate document automatically when using array when schema property is dynamoose.THIS if schema property is object", async () => {
						let getItemTimesCalled = 0;

						User = dynamoose.model("User", {"id": Number, "name": String, "parent": {"type": Array, "schema": [{"type": dynamoose.THIS}]}});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								getItemTimesCalled++;
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"L": [{"N": "2"}]}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.toJSON()).to.eql({
							"id": 1,
							"name": "Charlie",
							"parent": [2]
						});
						expect(getItemTimesCalled).to.eql(1);
					});

					it("Should autopopulate if model settings have populate set", async () => {
						User = dynamoose.model("User", {"id": Number, "name": String, "parent": dynamoose.THIS}, {"populate": "*"});
						dynamoose.aws.ddb.set({
							"getItem": (params) => {
								return {"promise": () => params.Key.id.N === "1" ? {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"N": "2"}}} : {"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}}};
							}
						});
						const user = await callType.func(User).bind(User)(1);
						expect(user.toJSON()).to.eql({
							"id": 1,
							"name": "Charlie",
							"parent": {
								"id": 2,
								"name": "Bob"
							}
						});
					});
				});

				it("Should throw error if DynamoDB responds with error", () => {
					getItemFunction = () => Promise.reject({"error": "Error"});

					return expect(callType.func(User).bind(User)(1)).to.be.rejectedWith({"error": "Error"});
				});

				it("Should return undefined if no object exists in DynamoDB", async () => {
					getItemFunction = () => Promise.resolve({});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.eql(undefined);
				});

				it("Should return object with correct values if Dynamo object consists properties that don't exist in schema", async () => {
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "hello": {"S": "world"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "name"]);
					expect(user.id).to.eql(1);
					expect(user.name).to.eql("Charlie");
				});

				it("Should return object with correct combine attribute without modifying", async () => {
					User = dynamoose.model("User", {"id": Number, "data1": String, "data2": String, "combine": {"type": {"value": "Combine", "settings": {"attributes": ["data1", "data2"]}}}});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "data1": {"S": "hello"}, "data2": {"S": "world"}, "combine": {"S": "random"}}});
					const user = await callType.func(User).bind(User)(1);
					expect(user).to.be.an("object");
					expect(Object.keys(user)).to.eql(["id", "data1", "data2", "combine"]);
					expect(user.id).to.eql(1);
					expect(user.data1).to.eql("hello");
					expect(user.data2).to.eql("world");
					expect(user.combine).to.eql("random");
				});

				it("Should throw error if Dynamo object contains properties that have type mismatch with schema", () => {
					User = dynamoose.model("User", {"id": Number, "name": String, "age": Number});
					getItemFunction = () => Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}, "age": {"S": "Hello World"}}});

					return expect(callType.func(User).bind(User)(1)).to.be.rejectedWith("Expected age to be of type number, instead found type string.");
				});

				it("Should wait for model to be ready prior to running DynamoDB API call", async () => {
					let calledGetItem = false;
					getItemFunction = () => {
						calledGetItem = true; return Promise.resolve({"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					};
					let describeTableResponse = {
						"Table": {"TableStatus": "CREATING"}
					};
					dynamoose.aws.ddb.set({
						"describeTable": () => ({
							"promise": () => Promise.resolve(describeTableResponse)
						}),
						"getItem": () => ({
							"promise": getItemFunction
						})
					});
					const model = dynamoose.model("User", {"id": Number, "name": String}, {"waitForActive": {"enabled": true, "check": {"frequency": 0, "timeout": 100}}});
					await utils.set_immediate_promise();

					let user;
					callType.func(model).bind(model)(1).then((item) => user = item);

					await utils.set_immediate_promise();
					expect(calledGetItem).to.be.false;
					expect(user).to.not.exist;
					expect(model.Model.pendingTasks.length).to.eql(1);

					describeTableResponse = {
						"Table": {"TableStatus": "ACTIVE"}
					};
					await model.Model.pendingTaskPromise();
					await utils.set_immediate_promise();
					expect(calledGetItem).to.be.true;
					expect({...user}).to.eql({"id": 1, "name": "Charlie"});
				});
			});
		});
	});

	describe("Model.batchGet", () => {
		let User, params, promiseFunction;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String});
			params = null;
			promiseFunction = null;
			dynamoose.aws.ddb.set({
				"batchGetItem": (paramsB) => {
					params = paramsB;
					return {"promise": promiseFunction};
				}
			});
		});
		afterEach(() => {
			User = null;
			params = null;
			promiseFunction = null;
			dynamoose.aws.ddb.revert();
		});

		it("Should be a function", () => {
			expect(User.batchGet).to.be.a("function");
		});

		const functionCallTypes = [
			{"name": "Promise", "func": (Model) => Model.batchGet},
			{"name": "Callback", "func": (Model) => util.promisify(Model.batchGet)}
		];

		functionCallTypes.forEach((callType) => {
			describe(callType.name, () => {
				it("Should send correct params to batchGetItem", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {}});
					await callType.func(User).bind(User)([1]);
					expect(params).to.be.an("object");
					expect(params).to.eql({
						"RequestItems": {
							"User": {
								"Keys": [
									{"id": {"N": "1"}}
								]
							}
						}
					});
				});

				it("Should send correct params to batchGetItem with attributes", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {}});
					await callType.func(User).bind(User)([1], {"attributes": ["id", "data"]});
					expect(params).to.be.an("object");
					expect(params).to.eql({
						"RequestItems": {
							"User": {
								"Keys": [
									{"id": {"N": "1"}}
								],
								"AttributesToGet": ["id", "data"]
							}
						}
					});
				});

				it("Should return correct request if setting option return to request", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {}});
					const paramsB = await callType.func(User).bind(User)([1], {"return": "request"});
					expect(params).to.not.exist;
					expect(paramsB).to.be.an("object");
					expect(paramsB).to.eql({
						"RequestItems": {
							"User": {
								"Keys": [
									{"id": {"N": "1"}}
								]
							}
						}
					});
				});

				it("Should send correct params to batchGetItem for multiple items", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}, {"id": {"N": "2"}, "name": {"S": "Bob"}}]}, "UnprocessedKeys": {}});
					await callType.func(User).bind(User)([1, 2]);
					expect(params).to.be.an("object");
					expect(params).to.eql({
						"RequestItems": {
							"User": {
								"Keys": [
									{"id": {"N": "1"}},
									{"id": {"N": "2"}}
								]
							}
						}
					});
				});

				it("Should return correct result from batchGet", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {}});
					const result = await callType.func(User).bind(User)([1]);
					expect(result).to.be.an("array");
					expect(result.unprocessedKeys).to.eql([]);
					expect(result.map((item) => ({...item}))).to.eql([
						{"id": 1, "name": "Charlie"}
					]);
				});

				it("Should return correct result from batchGet for multiple items", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}, {"id": {"N": "2"}, "name": {"S": "Bob"}}]}, "UnprocessedKeys": {}});
					const result = await callType.func(User).bind(User)([1, 2]);
					expect(result).to.be.an("array");
					expect(result.unprocessedKeys).to.eql([]);
					expect(result.map((item) => ({...item}))).to.eql([
						{"id": 1, "name": "Charlie"},
						{"id": 2, "name": "Bob"}
					]);
				});

				it("Should return correct result from batchGet for multiple items that aren't sorted correctly", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "2"}, "name": {"S": "Bob"}}, {"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {}});
					const result = await callType.func(User).bind(User)([1, 2]);
					expect(result).to.be.an("array");
					expect(result.unprocessedKeys).to.eql([]);
					expect(result.map((item) => ({...item}))).to.eql([
						{"id": 1, "name": "Charlie"},
						{"id": 2, "name": "Bob"}
					]);
				});

				it("Should return correct result from batchGet with unprocessed keys", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {"User": {"Keys": [{"id": {"N": 2}}]}}});
					const result = await callType.func(User).bind(User)([1, 2]);
					expect(result).to.be.an("array");
					expect(result.unprocessedKeys).to.eql([{"id": 2}]);
					expect(result.map((item) => ({...item}))).to.eql([
						{"id": 1, "name": "Charlie"}
					]);
				});

				it("Should return correct result from batchGet for multiple items with unprocessed keys", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}, {"id": {"N": "3"}, "name": {"S": "Bob"}}]}, "UnprocessedKeys": {"User": {"Keys": [{"id": {"N": 2}}]}}});
					const result = await callType.func(User).bind(User)([1, 2, 3]);
					expect(result).to.be.an("array");
					expect(result.unprocessedKeys).to.eql([{"id": 2}]);
					expect(result.map((item) => ({...item}))).to.eql([
						{"id": 1, "name": "Charlie"},
						{"id": 3, "name": "Bob"}
					]);
				});

				it("Should return correct result from batchGet for multiple items that aren't sorted with unprocessed keys", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "3"}, "name": {"S": "Bob"}}, {"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {"User": {"Keys": [{"id": {"N": 2}}]}}});
					const result = await callType.func(User).bind(User)([1, 2, 3]);
					expect(result).to.be.an("array");
					expect(result.unprocessedKeys).to.eql([{"id": 2}]);
					expect(result.map((item) => ({...item}))).to.eql([
						{"id": 1, "name": "Charlie"},
						{"id": 3, "name": "Bob"}
					]);
				});

				it("Should return correct result from batchGet for multiple unprocessed keys that aren't sorted", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {"User": {"Keys": [{"id": {"N": 3}}, {"id": {"N": 2}}]}}});
					const result = await callType.func(User).bind(User)([1, 2, 3]);
					expect(result).to.be.an("array");
					expect(result.unprocessedKeys).to.eql([{"id": 2}, {"id": 3}]);
					expect(result.map((item) => ({...item}))).to.eql([
						{"id": 1, "name": "Charlie"}
					]);
				});

				describe("Populate", () => {
					it("Should have populate function on response", async () => {
						promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {}});
						const result = await callType.func(User).bind(User)([1]);
						expect(result.populate).to.be.a("function");
					});

					it("Should autopopulate if model settings have populate set", async () => {
						User = dynamoose.model("User", {"id": Number, "name": String, "parent": dynamoose.THIS}, {"populate": "*"});
						dynamoose.aws.ddb.set({
							"getItem": () => {
								return {"promise": () => ({"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}})};
							},
							"batchGetItem": () => {
								return {"promise": () => ({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}, "parent": {"N": "2"}}]}, "UnprocessedKeys": {}})};
							}
						});
						const result = await callType.func(User).bind(User)([1]);
						expect(result.toJSON()).to.eql([{
							"id": 1,
							"name": "Charlie",
							"parent": {
								"id": 2,
								"name": "Bob"
							}
						}]);
					});
				});

				it("Should handle correctly if item not in Responses or UnprocessedKeys", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {"User": {"Keys": [{"id": {"N": 3}}, {"id": {"N": 2}}]}}});
					const result = await callType.func(User).bind(User)([1, 2, 3, 4]);
					expect(result).to.be.an("array");
					expect(result.unprocessedKeys).to.eql([{"id": 2}, {"id": 3}]);
					expect(result.map((item) => ({...item}))).to.eql([
						{"id": 1, "name": "Charlie"}
					]);
				});

				it("Should handle correctly if item not in Responses", async () => {
					promiseFunction = () => Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {}});
					const result = await callType.func(User).bind(User)([1, 2]);
					expect(result).to.be.an("array");
					expect(result.unprocessedKeys).to.eql([]);
					expect(result.map((item) => ({...item}))).to.eql([
						{"id": 1, "name": "Charlie"}
					]);
				});

				it("Should throw error if DynamoDB responds with error", () => {
					promiseFunction = () => Promise.reject({"error": "Error"});

					return expect(callType.func(User).bind(User)([1, 2, 3])).to.be.rejectedWith({"error": "Error"});
				});

				it("Should wait for model to be ready prior to running DynamoDB API call", async () => {
					let calledBatchGetItem = false;
					promiseFunction = () => {
						calledBatchGetItem = true; return Promise.resolve({"Responses": {"User": [{"id": {"N": "1"}, "name": {"S": "Charlie"}}]}, "UnprocessedKeys": {}});
					};
					let describeTableResponse = {
						"Table": {"TableStatus": "CREATING"}
					};
					dynamoose.aws.ddb.set({
						"describeTable": () => ({
							"promise": () => Promise.resolve(describeTableResponse)
						}),
						"batchGetItem": () => ({
							"promise": promiseFunction
						})
					});
					const model = dynamoose.model("User", {"id": Number, "name": String}, {"waitForActive": {"enabled": true, "check": {"frequency": 0, "timeout": 100}}});
					await utils.set_immediate_promise();

					let users;
					callType.func(model).bind(model)([1]).then((item) => users = item);

					await utils.set_immediate_promise();
					expect(calledBatchGetItem).to.be.false;
					expect(users).to.not.exist;
					expect(model.Model.pendingTasks.length).to.eql(1);

					describeTableResponse = {
						"Table": {"TableStatus": "ACTIVE"}
					};
					await model.Model.pendingTaskPromise();
					await utils.set_immediate_promise();
					expect(calledBatchGetItem).to.be.true;
					expect(users.map((user) => ({...user}))).to.eql([{"id": 1, "name": "Charlie"}]);
				});
			});
		});
	});

	describe("Model.create", () => {
		let User, createItemParams, createItemFunction;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String});
			dynamoose.aws.ddb.set({
				"putItem": (params) => {
					createItemParams = params;
					return {"promise": createItemFunction};
				}
			});
		});
		afterEach(() => {
			User = null;
			dynamoose.aws.ddb.revert();
		});

		it("Should be a function", () => {
			expect(User.create).to.be.a("function");
		});

		const functionCallTypes = [
			{"name": "Promise", "func": (Model) => Model.create},
			{"name": "Callback", "func": (Model) => util.promisify(Model.create)}
		];
		functionCallTypes.forEach((callType) => {
			describe(callType.name, () => {
				it("Should return correct result after saving with defaults", async () => {
					createItemFunction = () => Promise.resolve();

					User = dynamoose.model("User", {"id": Number, "name": String, "defaultValue": {"type": String, "default": "Hello World"}});

					const result = await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(result.toJSON()).to.eql({"id": 1, "name": "Charlie", "defaultValue": "Hello World"});
				});

				it("Should send correct params to putItem", async () => {
					createItemFunction = () => Promise.resolve();
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(createItemParams).to.be.an("object");
					expect(createItemParams).to.eql({
						"ConditionExpression": "attribute_not_exists(#__hash_key)",
						"ExpressionAttributeNames": {
							"#__hash_key": "id"
						},
						"Item": {
							"id": {
								"N": "1"
							},
							"name": {
								"S": "Charlie"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to putItem with value as undefined as first property", async () => {
					createItemFunction = () => Promise.resolve();
					await callType.func(User).bind(User)({"name": undefined, "id": 1});
					expect(createItemParams).to.be.an("object");
					expect(createItemParams).to.eql({
						"ConditionExpression": "attribute_not_exists(#__hash_key)",
						"ExpressionAttributeNames": {
							"#__hash_key": "id"
						},
						"Item": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to putItem with value as undefined as second property", async () => {
					createItemFunction = () => Promise.resolve();
					await callType.func(User).bind(User)({"id": 1, "name": undefined});
					expect(createItemParams).to.be.an("object");
					expect(createItemParams).to.eql({
						"ConditionExpression": "attribute_not_exists(#__hash_key)",
						"ExpressionAttributeNames": {
							"#__hash_key": "id"
						},
						"Item": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User"
					});
				});

				it("Should not include attributes that do not exist in schema", async () => {
					createItemFunction = () => Promise.resolve();
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie", "hello": "world"});
					expect(createItemParams.Item).to.eql({
						"id": {
							"N": "1"
						},
						"name": {
							"S": "Charlie"
						}
					});
				});

				it("Should overwrite if passed into options", async () => {
					createItemFunction = () => Promise.resolve();
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie"}, {"overwrite": true});
					expect(createItemParams).to.be.an("object");
					expect(createItemParams).to.eql({
						"Item": {
							"id": {
								"N": "1"
							},
							"name": {
								"S": "Charlie"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to putItem with set function", async () => {
					createItemFunction = () => Promise.resolve();
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "set": (val) => `${val}-set`}});
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(createItemParams).to.be.an("object");
					expect(createItemParams).to.eql({
						"ConditionExpression": "attribute_not_exists(#__hash_key)",
						"ExpressionAttributeNames": {
							"#__hash_key": "id"
						},
						"Item": {
							"id": {
								"N": "1"
							},
							"name": {
								"S": "Charlie-set"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to putItem with async set function", async () => {
					createItemFunction = () => Promise.resolve();
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "set": async (val) => `${val}-set`}});
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(createItemParams).to.be.an("object");
					expect(createItemParams).to.eql({
						"ConditionExpression": "attribute_not_exists(#__hash_key)",
						"ExpressionAttributeNames": {
							"#__hash_key": "id"
						},
						"Item": {
							"id": {
								"N": "1"
							},
							"name": {
								"S": "Charlie-set"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to putItem with combine attribute", async () => {
					createItemFunction = () => Promise.resolve();
					User = dynamoose.model("User", {"id": Number, "data1": String, "data2": String, "combine": {"type": {"value": "Combine", "settings": {"attributes": ["data1", "data2"]}}}});
					await callType.func(User).bind(User)({"id": 1, "data1": "hello", "data2": "world"});
					expect(createItemParams).to.be.an("object");
					expect(createItemParams).to.eql({
						"ConditionExpression": "attribute_not_exists(#__hash_key)",
						"ExpressionAttributeNames": {
							"#__hash_key": "id"
						},
						"Item": {
							"id": {
								"N": "1"
							},
							"data1": {
								"S": "hello"
							},
							"data2": {
								"S": "world"
							},
							"combine": {
								"S": "hello,world"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to putItem with value as null", async () => {
					const User2 = dynamoose.model("User", {"id": Number, "name": dynamoose.NULL});

					createItemFunction = () => Promise.resolve();
					await callType.func(User2).bind(User2)({"id": 1, "name": null});
					expect(createItemParams).to.be.an("object");
					expect(createItemParams).to.eql({
						"ConditionExpression": "attribute_not_exists(#__hash_key)",
						"ExpressionAttributeNames": {
							"#__hash_key": "id"
						},
						"Item": {
							"id": {
								"N": "1"
							},
							"name": {
								"NULL": true
							}
						},
						"TableName": "User"
					});
				});
			});
		});
	});

	describe("Model.batchPut", () => {
		let User, params, promiseFunction;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String});
			dynamoose.aws.ddb.set({
				"batchWriteItem": (paramsB) => {
					params = paramsB;
					return {"promise": promiseFunction};
				}
			});
		});
		afterEach(() => {
			User = null;
			params = null;
			promiseFunction = null;
			dynamoose.aws.ddb.revert();
		});

		it("Should be a function", () => {
			expect(User.batchPut).to.be.a("function");
		});

		const functionCallTypes = [
			{"name": "Promise", "func": (Model) => Model.batchPut},
			{"name": "Callback", "func": (Model) => util.promisify(Model.batchPut)}
		];
		functionCallTypes.forEach((callType) => {
			describe(callType.name, () => {
				it("Should should send correct parameters to batchWriteItem", async () => {
					promiseFunction = () => Promise.resolve({"UnprocessedItems": {}});
					await callType.func(User).bind(User)([{"id": 1, "name": "Charlie"}, {"id": 2, "name": "Bob"}]);
					expect(params).to.be.an("object");
					expect(params).to.eql({
						"RequestItems": {
							"User": [
								{
									"PutRequest": {
										"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}
									}
								},
								{
									"PutRequest": {
										"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}
									}
								}
							]
						}
					});
				});

				it("Should return correct result from batchPut with no UnprocessedItems", async () => {
					promiseFunction = () => Promise.resolve({"UnprocessedItems": {}});
					const result = await callType.func(User).bind(User)([{"id": 1, "name": "Charlie"}, {"id": 2, "name": "Bob"}]);
					expect(result).to.eql({
						"unprocessedItems": []
					});
				});

				it("Should return correct result from batchPut with UnprocessedItems", async () => {
					promiseFunction = () => Promise.resolve({"UnprocessedItems": {"User": [{"PutRequest": {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}}}]}});
					const result = await callType.func(User).bind(User)([{"id": 1, "name": "Charlie"}, {"id": 2, "name": "Bob"}]);
					expect(result).to.eql({
						"unprocessedItems": [{"id": 1, "name": "Charlie"}]
					});
				});

				it("Should return correct result from batchPut with UnprocessedItems in wrong order", async () => {
					promiseFunction = () => Promise.resolve({"UnprocessedItems": {"User": [{"PutRequest": {"Item": {"id": {"N": "3"}, "name": {"S": "Tim"}}}}, {"PutRequest": {"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}}}]}});
					const result = await callType.func(User).bind(User)([{"id": 1, "name": "Charlie"}, {"id": 2, "name": "Bob"}, {"id": 3, "name": "Tim"}]);
					expect(result).to.eql({
						"unprocessedItems": [{"id": 1, "name": "Charlie"}, {"id": 3, "name": "Tim"}]
					});
				});

				it("Should return request if return request setting is set", async () => {
					const result = await callType.func(User).bind(User)([{"id": 1, "name": "Charlie"}, {"id": 2, "name": "Bob"}], {"return": "request"});
					expect(params).to.not.exist;
					expect(result).to.eql({
						"RequestItems": {
							"User": [
								{
									"PutRequest": {
										"Item": {"id": {"N": "1"}, "name": {"S": "Charlie"}}
									}
								},
								{
									"PutRequest": {
										"Item": {"id": {"N": "2"}, "name": {"S": "Bob"}}
									}
								}
							]
						}
					});
				});

				it("Should should send correct parameters to batchWriteItem with combine atttribute", async () => {
					promiseFunction = () => Promise.resolve({"UnprocessedItems": {}});
					User = dynamoose.model("User", {"id": Number, "data1": String, "data2": String, "combine": {"type": {"value": "Combine", "settings": {"attributes": ["data1", "data2"]}}}});
					await callType.func(User).bind(User)([{"id": 1, "data1": "hello", "data2": "world"}, {"id": 2, "data1": "hello", "data2": "universe"}]);
					expect(params).to.be.an("object");
					expect(params).to.eql({
						"RequestItems": {
							"User": [
								{
									"PutRequest": {
										"Item": {"id": {"N": "1"}, "data1": {"S": "hello"}, "data2": {"S": "world"}, "combine": {"S": "hello,world"}}
									}
								},
								{
									"PutRequest": {
										"Item": {"id": {"N": "2"}, "data1": {"S": "hello"}, "data2": {"S": "universe"}, "combine": {"S": "hello,universe"}}
									}
								}
							]
						}
					});
				});

				it("Should throw error if error is returned from DynamoDB", () => {
					promiseFunction = () => Promise.reject({"error": "ERROR"});

					return expect(callType.func(User).bind(User)([{"id": 1, "name": "Charlie"}, {"id": 2, "name": "Bob"}])).to.be.rejectedWith({"error": "ERROR"});
				});
			});
		});
	});

	describe("Model.update", () => {
		let User, updateItemParams, updateItemFunction;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String, "age": Number});
			dynamoose.aws.ddb.set({
				"updateItem": (params) => {
					updateItemParams = params;
					return {"promise": updateItemFunction};
				}
			});
		});
		afterEach(() => {
			User = null;
			dynamoose.aws.ddb.revert();
		});

		it("Should be a function", () => {
			expect(User.update).to.be.a("function");
		});

		const functionCallTypes = [
			{"name": "Promise", "func": (Model) => Model.update},
			{"name": "Callback", "func": (Model) => util.promisify(Model.update)}
		];
		functionCallTypes.forEach((callType) => {
			describe(callType.name, () => {
				it("Should return request if settings passed in", async () => {
					updateItemFunction = () => Promise.resolve({});
					const response = await callType.func(User).bind(User)({"id": 1}, {"name": "Charlie"}, {"return": "request"});
					expect(response).to.be.an("object");
					expect(response).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for trying to update unknown properties with saveUnknown", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "name": String, "age": Number}, {"saveUnknown": true}));
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie", "random": "hello world"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name",
							"#a1": "random"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							},
							":v1": {
								"S": "hello world"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for trying to update unknown properties", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie", "random": "hello world"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for trying to update unknown list properties with saveUnknown", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "name": String, "age": Number}, {"saveUnknown": true}));
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie", "random": ["hello world"]});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name",
							"#a1": "random"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							},
							":v1": {
								"L": [{"S": "hello world"}]
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for trying to update unknown list properties with saveUnknown as $ADD", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "name": String, "age": Number}, {"saveUnknown": true}));
					await callType.func(User).bind(User)({"id": 1}, {"$SET": {"name": "Charlie"}, "$ADD": {"random": ["hello world"]}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name",
							"#a1": "random"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							},
							":v1": {
								"L": [{"S": "hello world"}]
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = list_append(#a1, :v1)",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for trying to update unknown list properties", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie", "random": ["hello world"]});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for single object update", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for single object update with rangeKey", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"pk": Number, "sk": {"type": Number, "rangeKey": true}, "name": String, "age": Number});
					await callType.func(User).bind(User)({"pk": 1, "sk": 1, "name": "Charlie"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"pk": {
								"N": "1"
							},
							"sk": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for single object update with multiple updates", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie", "age": 5});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name",
							"#a1": "age"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							},
							":v1": {
								"N": "5"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for single object update with multiple updates with rangeKey", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"pk": Number, "sk": {"type": Number, "rangeKey": true}, "name": String, "age": Number});
					await callType.func(User).bind(User)({"pk": 1, "sk": 1, "name": "Charlie", "age": 5});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name",
							"#a1": "age"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							},
							":v1": {
								"N": "5"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"pk": {
								"N": "1"
							},
							"sk": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with seperate key and update objects", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1}, {"name": "Charlie"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with seperate key and update objects with rangeKey", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"pk": Number, "sk": {"type": Number, "rangeKey": true}, "name": String, "age": Number});
					await callType.func(User).bind(User)({"pk": 1, "sk": 1}, {"name": "Charlie"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"pk": {
								"N": "1"
							},
							"sk": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with seperate key and update objects and multiple updates", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1}, {"name": "Charlie", "age": 5});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name",
							"#a1": "age"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							},
							":v1": {
								"N": "5"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with seperate key and update objects and multiple updates with rangeKey", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"pk": Number, "sk": {"type": Number, "rangeKey": true}, "name": String, "age": Number});
					await callType.func(User).bind(User)({"pk": 1, "sk": 1}, {"name": "Charlie", "age": 5});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name",
							"#a1": "age"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							},
							":v1": {
								"N": "5"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"pk": {
								"N": "1"
							},
							"sk": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem when using undefined to restore to default property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": () => "Charlie"}, "age": Number});
					await callType.func(User).bind(User)({"id": 1, "name": undefined});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem when using undefined to delete default property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": String, "age": Number});
					await callType.func(User).bind(User)({"id": 1, "name": undefined});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"UpdateExpression": "REMOVE #a0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem when using dynamoose.UNDEFINED to delete default property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": () => "Charlie"}, "age": Number});
					await callType.func(User).bind(User)({"id": 1, "name": dynamoose.UNDEFINED});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"UpdateExpression": "REMOVE #a0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem when using dynamoose.UNDEFINED to delete default property using $REMOVE", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": () => "Charlie"}, "age": Number});
					await callType.func(User).bind(User)({"id": 1}, {"$REMOVE": {"name": dynamoose.UNDEFINED}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"UpdateExpression": "REMOVE #a0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem when using dynamoose.UNDEFINED to delete default property using $SET", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": () => "Charlie"}, "age": Number});
					await callType.func(User).bind(User)({"id": 1}, {"$SET": {"name": dynamoose.UNDEFINED}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"UpdateExpression": "REMOVE #a0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $SET update expression", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1}, {"$SET": {"name": "Tim"}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Tim"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $SET update expression and multiple property updates", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1}, {"$SET": {"name": "Charlie", "age": 5}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name",
							"#a1": "age"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							},
							":v1": {
								"N": "5"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $SET update expression for list", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "friends": {"type": Array, "schema": [String]}});
					await callType.func(User).bind(User)({"id": 1}, {"friends": ["Bob"]});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "friends"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"L": [
									{"S": "Bob"}
								]
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $ADD update expression", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"age": 5}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "age"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": "5"
							}
						},
						"UpdateExpression": "ADD #a0 :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $ADD and $SET update expression", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"age": 5}, "$SET": {"name": "Bob"}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "age",
							"#a1": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": "5"
							},
							":v1": {
								"S": "Bob"
							}
						},
						"UpdateExpression": "ADD #a0 :v0 SET #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $ADD and $SET update expression but $SET expression not as object", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"age": 5}, "name": "Bob"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "age",
							"#a1": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": "5"
							},
							":v1": {
								"S": "Bob"
							}
						},
						"UpdateExpression": "ADD #a0 :v0 SET #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $ADD with one item for list append", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": String, "friends": {"type": Array, "schema": [String]}});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"friends": "Tim"}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "friends"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"L": [{"S": "Tim"}]
							}
						},
						"UpdateExpression": "SET #a0 = list_append(#a0, :v0)",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $ADD with multiple items for list append", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": String, "friends": {"type": Array, "schema": [String]}});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"friends": ["Tim", "Charlie"]}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "friends"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"L": [{"S": "Tim"}, {"S": "Charlie"}]
							}
						},
						"UpdateExpression": "SET #a0 = list_append(#a0, :v0)",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $REMOVE", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1}, {"$REMOVE": {"age": null}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "age"
						},
						"UpdateExpression": "REMOVE #a0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $REMOVE saveUnknown property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "name": String}, {"saveUnknown": ["age"]}));
					await callType.func(User).bind(User)({"id": 1}, {"$REMOVE": {"age": null}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "age"
						},
						"UpdateExpression": "REMOVE #a0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $REMOVE as array", async () => {
					updateItemFunction = () => Promise.resolve({});
					await callType.func(User).bind(User)({"id": 1}, {"$REMOVE": ["age"]});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "age"
						},
						"UpdateExpression": "REMOVE #a0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $SET date", async () => {
					updateItemFunction = () => Promise.resolve({});
					const date = new Date();
					User = dynamoose.model("User", {"id": Number, "birthday": Date});
					await callType.func(User).bind(User)({"id": 1}, {"birthday": date});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "birthday"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": `${date.getTime()}`
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $SET date as number", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "birthday": Date});
					await callType.func(User).bind(User)({"id": 1}, {"birthday": 0});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "birthday"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": "0"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with $ADD date as number", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "birthday": Date});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"birthday": 1000}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "birthday"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": "1000"
							}
						},
						"UpdateExpression": "ADD #a0 :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem for timestamps with updateAt", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "name": String}, {"timestamps": true}));
					const date = Date.now();
					await callType.func(User).bind(User)({"id": 1}, {"name": "Charlie"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "updatedAt",
							"#a1": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": updateItemParams.ExpressionAttributeValues[":v0"].N
							},
							":v1": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
					expect(parseInt(updateItemParams.ExpressionAttributeValues[":v0"].N)).to.be.within(date - 10, date + 10);
				});

				it("Should send correct params to updateItem for timestamps with updateAt with custom parameter names", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "name": String}, {"timestamps": {"createdAt": "created", "updatedAt": "updated"}}));
					const date = Date.now();
					await callType.func(User).bind(User)({"id": 1}, {"name": "Charlie"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "updated",
							"#a1": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": updateItemParams.ExpressionAttributeValues[":v0"].N
							},
							":v1": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
					expect(parseInt(updateItemParams.ExpressionAttributeValues[":v0"].N)).to.be.within(date - 10, date + 10);
				});

				it("Should send correct params to updateItem for timestamps with updateAt with multiple custom parameter names", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "name": String}, {"timestamps": {"createdAt": ["a1", "a2"], "updatedAt": ["b1", "b2"]}}));
					const date = Date.now();
					await callType.func(User).bind(User)({"id": 1}, {"name": "Charlie"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "b1",
							"#a1": "b2",
							"#a2": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": updateItemParams.ExpressionAttributeValues[":v0"].N
							},
							":v1": {
								"N": updateItemParams.ExpressionAttributeValues[":v1"].N
							},
							":v2": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1, #a2 = :v2",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
					expect(parseInt(updateItemParams.ExpressionAttributeValues[":v0"].N)).to.be.within(date - 10, date + 10);
					expect(parseInt(updateItemParams.ExpressionAttributeValues[":v1"].N)).to.be.within(date - 10, date + 10);
					expect(parseInt(updateItemParams.ExpressionAttributeValues[":v0"].N)).to.eql(parseInt(updateItemParams.ExpressionAttributeValues[":v1"].N));
				});

				it("Should send correct params to updateItem with conditional", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "name": String, "active": Boolean}));
					const condition = new dynamoose.Condition("active").eq(true);
					await callType.func(User).bind(User)({"id": 1}, {"name": "Charlie"}, {condition});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a1": "name",
							"#a0": "active"
						},
						"ExpressionAttributeValues": {
							":v1": {
								"S": "Charlie"
							},
							":v0": {
								"BOOL": true
							}
						},
						"UpdateExpression": "SET #a1 = :v1",
						"ConditionExpression": "#a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct params to updateItem with returnValues", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "name": String, "active": Boolean}));
					await callType.func(User).bind(User)({"id": 1}, {"name": "Charlie"}, {"returnValues": "NONE"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Charlie"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "NONE"
					});
				});

				it("Should return updated document upon success", async () => {
					updateItemFunction = () => Promise.resolve({"Attributes": {"id": {"N": "1"}, "name": {"S": "Charlie"}}});
					const result = await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(result.constructor.name).to.eql("Document");
					expect({...result}).to.eql({
						"id": 1,
						"name": "Charlie"
					});
				});

				it("Should return updated document with object property upon success", async () => {
					User = dynamoose.model("User", new dynamoose.Schema({"id": Number, "address": Object}, {"saveUnknown": true}));
					updateItemFunction = () => Promise.resolve({"Attributes": {"id": {"N": "1"}, "address": {"M": {"zip": {"N": "12345"}, "country": {"S": "world"}}}}});
					const result = await callType.func(User).bind(User)({"id": 1, "address": {"zip": 12345, "country": "world"}});
					expect(result.constructor.name).to.eql("Document");
					expect({...result}).to.eql({
						"id": 1,
						"address": {"zip": 12345, "country": "world"}
					});
				});

				it("Should not throw error if validation passes", () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "myNumber": {"type": Number, "validate": (val) => val > 10}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"myNumber": 11})).to.not.be.rejected;
				});

				it("Should not throw error if validation doesn't pass when using $ADD", () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "myNumber": {"type": Number, "validate": (val) => val > 10}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"$ADD": {"myNumber": 5}})).to.not.be.rejected;
				});

				it("Should throw error if validation doesn't pass", () => {
					updateItemFunction = () => Promise.reject({"error": "ERROR"});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "validate": (val) => val.length > 10}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"name": "Bob"})).to.be.rejectedWith("name with a value of Bob had a validation error when trying to save the document");
				});

				it("Should throw error if value not in enum", () => {
					updateItemFunction = () => Promise.reject({"error": "ERROR"});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "enum": ["Bob", "Tim"]}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"name": "Todd"})).to.be.rejectedWith("name must equal [\"Bob\",\"Tim\"], but is set to Todd");
				});

				it("Should not throw error if value is in enum", () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "enum": ["Bob", "Tim"]}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"name": "Bob"})).to.not.be.rejected;
				});

				it("Should throw error for type mismatch for set", () => {
					updateItemFunction = () => Promise.reject({"error": "ERROR"});

					return expect(callType.func(User).bind(User)({"id": 1}, {"name": false})).to.be.rejectedWith("Expected name to be of type string, instead found type boolean.");
				});

				it("Should throw error for type mismatch for add", () => {
					updateItemFunction = () => Promise.reject({"error": "ERROR"});
					User = dynamoose.model("User", {"id": Number, "myNumber": Number});

					return expect(callType.func(User).bind(User)({"id": 1}, {"$ADD": {"myNumber": false}})).to.be.rejectedWith("Expected myNumber to be of type number, instead found type boolean.");
				});

				it("Should throw error for one item list append type mismatch", () => {
					updateItemFunction = () => Promise.reject({"error": "ERROR"});
					User = dynamoose.model("User", {"id": Number, "name": String, "friends": {"type": Array, "schema": [String]}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"$ADD": {"friends": false}})).to.be.rejectedWith("Expected friends.0 to be of type string, instead found type boolean.");
				});

				it("Should throw error for multiple item list append type mismatch", () => {
					updateItemFunction = () => Promise.reject({"error": "ERROR"});
					User = dynamoose.model("User", {"id": Number, "name": String, "friends": {"type": Array, "schema": [String]}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"$ADD": {"friends": [1, 5]}})).to.be.rejectedWith("Expected friends.0 to be of type string, instead found type number.");
				});

				it("Should throw error if trying to remove required property", () => {
					updateItemFunction = () => Promise.reject({"error": "ERROR"});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "required": true}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"$REMOVE": ["name"]})).to.be.rejectedWith("name is a required property but has no value when trying to save document");
				});

				it("Should not throw error if trying to modify required property", () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "required": true}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"name": "Bob"})).to.not.be.rejected;
				});

				it("Should not throw error if not modifying required property", () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "required": true}, "friends": {"type": Set, "schema": [String]}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"friends": ["Bob"]})).to.not.be.rejected;
				});

				it("Should throw error if trying to replace object without nested required property", () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data": {"type": Object, "schema": {"name": String, "age": {"type": Number, "required": true}}}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"data": {"name": "Charlie"}})).to.be.rejectedWith("data.age is a required property but has no value when trying to save document");
				});

				it("Should throw error if trying to replace object with $SET without nested required property", () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data": {"type": Object, "schema": {"name": String, "age": {"type": Number, "required": true}}}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"$SET": {"data": {"name": "Charlie"}}})).to.be.rejectedWith("data.age is a required property but has no value when trying to save document");
				});

				it("Should use default value if deleting property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": "Bob"}});
					await callType.func(User).bind(User)({"id": 1}, {"$REMOVE": ["name"]});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Bob"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Shouldn't use default value if modifying property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": "Bob"}});
					await callType.func(User).bind(User)({"id": 1}, {"name": "Tim"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Tim"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Shouldn't use default value if modifying different property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": "Bob"}, "data": String});
					await callType.func(User).bind(User)({"id": 1}, {"data": "test"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "test"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should use forceDefault value if deleting property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": "Bob", "forceDefault": true}});
					await callType.func(User).bind(User)({"id": 1}, {"$REMOVE": ["name"]});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Bob"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should use forceDefault value if modifying property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": "Bob", "forceDefault": true}});
					await callType.func(User).bind(User)({"id": 1}, {"name": "Tim"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Bob"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should use forceDefault value if adding to property that is a string set", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "friends": {"type": Set, "schema": [String], "default": ["Bob"], "forceDefault": true}});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"friends": ["Tim"]}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "friends"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"SS": ["Bob"]
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should use forceDefault value if adding to property that is a string list", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "friends": {"type": Array, "schema": [String], "default": ["Bob"], "forceDefault": true}});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"friends": ["Tim"]}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "friends"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"L": [
									{"S": "Bob"}
								]
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should use forceDefault value if modifying different property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "default": "Bob", "forceDefault": true}, "data": String});
					await callType.func(User).bind(User)({"id": 1}, {"data": "test"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data",
							"#a1": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "test"
							},
							":v1": {
								"S": "Bob"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Shouldn't conform to enum if property isn't being updated", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "enum": ["Bob", "Tim"]}, "data": String});
					await callType.func(User).bind(User)({"id": 1}, {"data": "test"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "test"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should call set modifier if setting property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "set": (val) => `${val}-set`}});
					await callType.func(User).bind(User)({"id": 1}, {"name": "Bob"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Bob-set"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should call set modifier if setting property using $SET", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "set": (val) => `${val}-set`}});
					await callType.func(User).bind(User)({"id": 1}, {"$SET": {"name": "Bob"}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Bob-set"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should not call set modifier if adding to property", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "age": {"type": Number, "set": (val) => val * 10}});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"age": 5}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "age"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": "5"
							}
						},
						"UpdateExpression": "ADD #a0 :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should throw error if updating one combine property", () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data1": String, "data2": String, "combine": {"type": {"value": "Combine", "settings": {"attributes": ["data1", "data2"]}}}});

					return expect(callType.func(User).bind(User)({"id": 1}, {"data1": "Charlie"})).to.be.rejectedWith("You must update all or none of the combine attributes when running Model.update. Missing combine attributes: data2.");
				});

				it("Shouldn't throw error if update with property allowing multiple types as first type", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data": [String, Number]});

					await callType.func(User).bind(User)({"id": 1}, {"data": "Bob"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "Bob"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Shouldn't throw error if update with property allowing multiple types as second type", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data": [String, Number]});

					await callType.func(User).bind(User)({"id": 1}, {"data": 2});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"N": "2"
							}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should throw error if using multiple types with combine type", () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data1": String, "data2": String, "combine": ["Combine", "String"]});

					return expect(callType.func(User).bind(User)({"id": 1}, {"data1": "Charlie", "data2": "Fish"})).to.be.rejectedWith("Combine type is not allowed to be used with multiple types.");
				});

				it("Should send correct parameters when updating all combine properties", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data1": String, "data2": String, "combine": {"type": {"value": "Combine", "settings": {"attributes": ["data1", "data2"]}}}});
					await callType.func(User).bind(User)({"id": 1}, {"data1": "hello", "data2": "world"});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data1",
							"#a1": "data2",
							"#a2": "combine"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "hello"
							},
							":v1": {
								"S": "world"
							},
							":v2": {
								"S": "hello,world"
							}
						},
						"UpdateExpression": "SET #a0 = :v0, #a1 = :v1, #a2 = :v2",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct parameters when updating or removing all combine properties", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data1": String, "data2": String, "combine": {"type": {"value": "Combine", "settings": {"attributes": ["data1", "data2"]}}}});
					await callType.func(User).bind(User)({"id": 1}, {"$SET": {"data1": "hello"}, "$REMOVE": {"data2": "world"}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data1",
							"#a1": "data2",
							"#a2": "combine"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"S": "hello"
							},
							":v2": {
								"S": "hello"
							}
						},
						"UpdateExpression": "REMOVE #a1 SET #a0 = :v0, #a2 = :v2",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct parameters when adding an element to a set", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data1": {"type": Set, "schema": [String]}});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"data1": ["test1"]}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data1"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"SS": ["test1"]
							}
						},
						"UpdateExpression": "ADD #a0 :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct parameters when adding multiple elements to a Set", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data1": {"type": Set, "schema": [String]}});
					await callType.func(User).bind(User)({"id": 1}, {"$ADD": {"data1": ["test1", "test2"]}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data1"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"SS": ["test1", "test2"]
							}
						},
						"UpdateExpression": "ADD #a0 :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct parameters when removing an element from a Set", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data1": {"type": Set, "schema": [String]}});
					await callType.func(User).bind(User)({"id": 1}, {"$DELETE": {"data1": ["test1"]}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data1"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"SS": ["test1"]
							}
						},
						"UpdateExpression": "DELETE #a0 :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct parameters when removing multiple elements from a Set", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data1": {"type": Set, "schema": [String]}});
					await callType.func(User).bind(User)({"id": 1}, {"$DELETE": {"data1": ["test1", "test2"]}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data1"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"SS": ["test1", "test2"]
							}
						},
						"UpdateExpression": "DELETE #a0 :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should send correct parameters when removing an element from a Set with other required parameters", async () => {
					updateItemFunction = () => Promise.resolve({});
					User = dynamoose.model("User", {"id": Number, "data1": {"type": Set, "schema": [String]}, "data2": {"type": String, "required": true}});
					await callType.func(User).bind(User)({"id": 1}, {"$DELETE": {"data1": ["test1"]}});
					expect(updateItemParams).to.be.an("object");
					expect(updateItemParams).to.eql({
						"ExpressionAttributeNames": {
							"#a0": "data1"
						},
						"ExpressionAttributeValues": {
							":v0": {
								"SS": ["test1"]
							}
						},
						"UpdateExpression": "DELETE #a0 :v0",
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ReturnValues": "ALL_NEW"
					});
				});

				it("Should throw error if AWS throws error", () => {
					updateItemFunction = () => Promise.reject({"error": "ERROR"});

					return expect(callType.func(User).bind(User)({"id": 1}, {"$ADD": {"age": 5}, "name": "Bob"})).to.be.rejectedWith({"error": "ERROR"});
				});
			});
		});
	});

	describe("Model.delete", () => {
		let User, deleteItemParams, deleteItemFunction;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String});
			dynamoose.aws.ddb.set({
				"deleteItem": (params) => {
					deleteItemParams = params;
					return {"promise": deleteItemFunction};
				}
			});
		});
		afterEach(() => {
			User = null;
			deleteItemParams = null;
			deleteItemFunction = null;
			dynamoose.aws.ddb.revert();
		});

		it("Should be a function", () => {
			expect(User.delete).to.be.a("function");
		});

		const functionCallTypes = [
			{"name": "Promise", "func": (Model) => Model.delete},
			{"name": "Callback", "func": (Model) => util.promisify(Model.delete)}
		];
		functionCallTypes.forEach((callType) => {
			describe(callType.name, () => {
				it("Should should send correct parameters to deleteItem", async () => {
					deleteItemFunction = () => Promise.resolve();
					await callType.func(User).bind(User)(1);
					expect(deleteItemParams).to.be.an("object");
					expect(deleteItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to deleteItem if we pass in an object", async () => {
					deleteItemFunction = () => Promise.resolve();
					await callType.func(User).bind(User)({"id": 1});
					expect(deleteItemParams).to.be.an("object");
					expect(deleteItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to deleteItem if we pass in an object with range key", async () => {
					deleteItemFunction = () => Promise.resolve();
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "rangeKey": true}});
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(deleteItemParams).to.be.an("object");
					expect(deleteItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							},
							"name": {
								"S": "Charlie"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to deleteItem if we pass in an entire object with unnecessary attributes", async () => {
					deleteItemFunction = () => Promise.resolve();
					await callType.func(User).bind(User)({"id": 1, "name": "Charlie"});
					expect(deleteItemParams).to.be.an("object");
					expect(deleteItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User"
					});
				});

				it("Should send correct params to deleteItem if we pass in an entire object with unnecessary attributes with range key", async () => {
					deleteItemFunction = () => Promise.resolve();
					User = dynamoose.model("User", {"id": Number, "name": {"type": String, "rangeKey": true}});
					await callType.func(User).bind(User)({"id": 1, "type": "bar", "name": "Charlie"});
					expect(deleteItemParams).to.be.an("object");
					expect(deleteItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							},
							"name": {
								"S": "Charlie"
							}
						},
						"TableName": "User"
					});
				});

				it("Should successfully add a condition if a condition is passed in", async () => {
					const condition = new dynamoose.Condition().filter("id").exists();
					deleteItemFunction = () => Promise.resolve();
					await callType.func(User).bind(User)({"id": 1}, {"condition": condition});
					expect(deleteItemParams).to.be.an("object");
					expect(deleteItemParams).to.eql({
						"Key": {
							"id": {
								"N": "1"
							}
						},
						"TableName": "User",
						"ConditionExpression": "attribute_exists (#a0)",
						"ExpressionAttributeNames": {
							"#a0": "id"
						}
					});
				});

				it("Should return request if return request setting is set", async () => {
					const result = await callType.func(User).bind(User)(1, {"return": "request"});
					expect(deleteItemParams).to.not.exist;
					expect(result).to.eql({
						"Key": {"id": {"N": "1"}},
						"TableName": "User"
					});
				});

				it("Should throw error if error is returned from DynamoDB", () => {
					deleteItemFunction = () => Promise.reject({"error": "ERROR"});

					return expect(callType.func(User).bind(User)({"id": 1, "name": "Charlie"})).to.be.rejectedWith({"error": "ERROR"});
				});
			});
		});

		it("Should send correct params to deleteItem if we pass in an entire object with unnecessary attributes with range key", async () => {
			deleteItemFunction = () => Promise.resolve();

			const schema = {
				"PK": {"type": String, "hashKey": true},
				"SK": {"type": String, "rangeKey": true},
				"someAttribute": {"type": String}
			};
			const ExampleModel = dynamoose.model("TestTable", schema);

			const example = new ExampleModel({
				"PK": "primarKey",
				"SK": "sortKey",
				"someAttribute": "someValue"
			});

			const func = (Model) => Model.delete;
			await func(ExampleModel).bind(ExampleModel)(example);
			expect(deleteItemParams).to.be.an("object");
			expect(deleteItemParams).to.eql({
				"Key": {
					"PK": {
						"S": "primarKey"
					},
					"SK": {
						"S": "sortKey"
					}
				},
				"TableName": "TestTable"
			});
		});
	});

	describe("Model.batchDelete", () => {
		let User, params, promiseFunction;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String});
			dynamoose.aws.ddb.set({
				"batchWriteItem": (paramsB) => {
					params = paramsB;
					return {"promise": promiseFunction};
				}
			});
		});
		afterEach(() => {
			User = null;
			params = null;
			promiseFunction = null;
			dynamoose.aws.ddb.revert();
		});

		it("Should be a function", () => {
			expect(User.batchDelete).to.be.a("function");
		});

		const functionCallTypes = [
			{"name": "Promise", "func": (Model) => Model.batchDelete},
			{"name": "Callback", "func": (Model) => util.promisify(Model.batchDelete)}
		];
		functionCallTypes.forEach((callType) => {
			describe(callType.name, () => {
				it("Should should send correct parameters to batchWriteItem", async () => {
					promiseFunction = () => Promise.resolve({"UnprocessedItems": {}});
					await callType.func(User).bind(User)([1, 2]);
					expect(params).to.be.an("object");
					expect(params).to.eql({
						"RequestItems": {
							"User": [
								{
									"DeleteRequest": {
										"Key": {"id": {"N": "1"}}
									}
								},
								{
									"DeleteRequest": {
										"Key": {"id": {"N": "2"}}
									}
								}
							]
						}
					});
				});

				it("Should return correct result from batchDelete with no UnprocessedItems", async () => {
					promiseFunction = () => Promise.resolve({"UnprocessedItems": {}});
					const result = await callType.func(User).bind(User)([1, 2]);
					expect(result).to.eql({
						"unprocessedItems": []
					});
				});

				it("Should return correct result from batchDelete with UnprocessedItems", async () => {
					promiseFunction = () => Promise.resolve({"UnprocessedItems": {"User": [{"DeleteRequest": {"Key": {"id": {"N": "1"}}}}]}});
					const result = await callType.func(User).bind(User)([1, 2]);
					expect(result).to.eql({
						"unprocessedItems": [{"id": 1}]
					});
				});

				it("Should return correct result from batchDelete with UnprocessedItems in wrong order", async () => {
					promiseFunction = () => Promise.resolve({"UnprocessedItems": {"User": [{"DeleteRequest": {"Key": {"id": {"N": "3"}}}}, {"DeleteRequest": {"Key": {"id": {"N": "1"}}}}]}});
					const result = await callType.func(User).bind(User)([1, 2, 3]);
					expect(result).to.eql({
						"unprocessedItems": [{"id": 1}, {"id": 3}]
					});
				});

				it("Should return request if return request setting is set", async () => {
					const result = await callType.func(User).bind(User)([1, 2], {"return": "request"});
					expect(params).to.not.exist;
					expect(result).to.eql({
						"RequestItems": {
							"User": [
								{
									"DeleteRequest": {
										"Key": {"id": {"N": "1"}}
									}
								},
								{
									"DeleteRequest": {
										"Key": {"id": {"N": "2"}}
									}
								}
							]
						}
					});
				});

				it("Should throw error if error is returned from DynamoDB", () => {
					promiseFunction = () => Promise.reject({"error": "ERROR"});

					return expect(callType.func(User).bind(User)([{"id": 1, "name": "Charlie"}])).to.be.rejectedWith({"error": "ERROR"});
				});
			});
		});
	});

	describe("Model.table.create.request", () => {
		it("Should be a function", () => {
			expect(dynamoose.model("User", {"id": String}).table.create.request).to.be.a("function");
		});

		it("Should return correct result", async () => {
			expect(await dynamoose.model("User", {"id": String}).table.create.request()).to.eql({
				"TableName": "User",
				"ProvisionedThroughput": {
					"ReadCapacityUnits": 1,
					"WriteCapacityUnits": 1
				},
				"AttributeDefinitions": [
					{
						"AttributeName": "id",
						"AttributeType": "S"
					}
				],
				"KeySchema": [
					{
						"AttributeName": "id",
						"KeyType": "HASH"
					}
				]
			});
		});

		it("Should reject if has multiple types for hashKey", () => {
			return expect(dynamoose.model("User", {"id": [String, Number]}).table.create.request()).to.eventually.rejectedWith("You can not have multiple types for attribute definition: id.");
		});

		it("Should reject if has multiple types for rangeKey", () => {
			return expect(dynamoose.model("User", {"id": String, "rangeKey": {"type": [String, Number], "rangeKey": true}}).table.create.request()).to.eventually.rejectedWith("You can not have multiple types for attribute definition: rangeKey.");
		});
	});

	describe("Model.transaction", () => {
		let User;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String});
		});
		afterEach(() => {
			User = null;
		});

		it("Should be an object", () => {
			expect(User.transaction).to.be.an("object");
		});

		describe("Model.transaction.get", () => {
			it("Should be a function", () => {
				expect(User.transaction.get).to.be.a("function");
			});

			it("Should return an object", async () => {
				expect(await User.transaction.get(1)).to.be.an("object");
			});

			it("Should return correct result", async () => {
				expect(await User.transaction.get(1)).to.eql({
					"Get": {
						"Key": {"id": {"N": "1"}},
						"TableName": "User"
					}
				});
			});

			it("Should print warning if passing callback", () => {
				let result;
				const oldWarn = console.warn;
				console.warn = (warning) => result = warning;
				User.transaction.get(1, utils.empty_function);
				console.warn = oldWarn;

				expect(result).to.eql("Dynamoose Warning: Passing callback function into transaction method not allowed. Removing callback function from list of arguments.");
			});
		});

		describe("Model.transaction.create", () => {
			it("Should be a function", () => {
				expect(User.transaction.create).to.be.a("function");
			});

			it("Should return an object", async () => {
				expect(await User.transaction.create({"id": 1})).to.be.an("object");
			});

			it("Should return correct result", async () => {
				expect(await User.transaction.create({"id": 1})).to.eql({
					"Put": {
						"ConditionExpression": "attribute_not_exists(#__hash_key)",
						"ExpressionAttributeNames": {
							"#__hash_key": "id"
						},
						"Item": {"id": {"N": "1"}},
						"TableName": "User"
					}
				});
			});

			it("Should return correct result with overwrite set to true", async () => {
				expect(await User.transaction.create({"id": 1}, {"overwrite": true})).to.eql({
					"Put": {
						"Item": {"id": {"N": "1"}},
						"TableName": "User"
					}
				});
			});

			it("Should return correct result with overwrite set to false", async () => {
				expect(await User.transaction.create({"id": 1}, {"overwrite": false})).to.eql({
					"Put": {
						"ConditionExpression": "attribute_not_exists(#__hash_key)",
						"ExpressionAttributeNames": {
							"#__hash_key": "id"
						},
						"Item": {"id": {"N": "1"}},
						"TableName": "User"
					}
				});
			});

			it("Should print warning if passing callback", () => {
				let result;
				const oldWarn = console.warn;
				console.warn = (warning) => result = warning;
				User.transaction.create({"id": 1}, {"overwrite": false}, utils.empty_function);
				console.warn = oldWarn;

				expect(result).to.eql("Dynamoose Warning: Passing callback function into transaction method not allowed. Removing callback function from list of arguments.");
			});
		});

		describe("Model.transaction.delete", () => {
			it("Should be a function", () => {
				expect(User.transaction.delete).to.be.a("function");
			});

			it("Should return an object", async () => {
				expect(await User.transaction.delete(1)).to.be.an("object");
			});

			it("Should return correct result", async () => {
				expect(await User.transaction.delete(1)).to.eql({
					"Delete": {
						"Key": {"id": {"N": "1"}},
						"TableName": "User"
					}
				});
			});

			it("Should print warning if passing callback", () => {
				let result;
				const oldWarn = console.warn;
				console.warn = (warning) => result = warning;
				User.transaction.delete(1, utils.empty_function);
				console.warn = oldWarn;

				expect(result).to.eql("Dynamoose Warning: Passing callback function into transaction method not allowed. Removing callback function from list of arguments.");
			});

			it("Should keep range keys with 0 value", async () => {
				User = dynamoose.model("User", {"id": String, "order": {"type": Number, "rangeKey": true}});
				expect(await User.transaction.delete({"id": "foo", "order": 0})).to.eql({
					"Delete": {
						"Key": {"id": {"S": "foo"}, "order": {"N": "0"}},
						"TableName": "User"
					}
				});
			});
		});

		describe("Model.transaction.update", () => {
			it("Should be a function", () => {
				expect(User.transaction.update).to.be.a("function");
			});

			it("Should return an object", async () => {
				expect(await User.transaction.update({"id": 1, "name": "Bob"})).to.be.an("object");
			});

			it("Should return correct result", async () => {
				expect(await User.transaction.update({"id": 1, "name": "Bob"})).to.eql({
					"Update": {
						"Key": {"id": {"N": "1"}},
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {"S": "Bob"}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"TableName": "User"
					}
				});
			});

			it("Should return correct result with settings", async () => {
				expect(await User.transaction.update({"id": 1}, {"name": "Bob"}, {"return": "request"})).to.eql({
					"Update": {
						"Key": {"id": {"N": "1"}},
						"ExpressionAttributeNames": {
							"#a0": "name"
						},
						"ExpressionAttributeValues": {
							":v0": {"S": "Bob"}
						},
						"UpdateExpression": "SET #a0 = :v0",
						"TableName": "User"
					}
				});
			});

			it("Should print warning if passing callback", () => {
				let result;
				const oldWarn = console.warn;
				console.warn = (warning) => result = warning;
				User.transaction.update({"id": 1, "name": "Bob"}, utils.empty_function);
				console.warn = oldWarn;

				expect(result).to.eql("Dynamoose Warning: Passing callback function into transaction method not allowed. Removing callback function from list of arguments.");
			});
		});

		describe("Model.transaction.condition", () => {
			it("Should be a function", () => {
				expect(User.transaction.condition).to.be.a("function");
			});

			it("Should return an object", async () => {
				expect(await User.transaction.condition(1)).to.be.an("object");
			});

			it("Should return correct result", async () => {
				expect(await User.transaction.condition(1)).to.eql({
					"ConditionCheck": {
						"Key": {"id": {"N": "1"}},
						"TableName": "User"
					}
				});
			});

			it("Should return correct result for object based key", async () => {
				User = dynamoose.model("User", {"id": Number, "name": {"type": String, "rangeKey": true}});
				expect(await User.transaction.condition({"id": 1, "name": "Bob"})).to.eql({
					"ConditionCheck": {
						"Key": {"id": {"N": "1"}, "name": {"S": "Bob"}},
						"TableName": "User"
					}
				});
			});

			it("Should return correct result with conditional", async () => {
				expect(await User.transaction.condition(1, new dynamoose.Condition("age").gt(13))).to.eql({
					"ConditionCheck": {
						"ConditionExpression": "#a0 > :v0",
						"ExpressionAttributeNames": {
							"#a0": "age"
						},
						"ExpressionAttributeValues": {
							":v0": {"N": "13"}
						},
						"Key": {"id": {"N": "1"}},
						"TableName": "User"
					}
				});
			});

			it("Should print warning if passing callback", () => {
				let result;
				const oldWarn = console.warn;
				console.warn = (warning) => result = warning;
				User.transaction.condition(1, utils.empty_function);
				console.warn = oldWarn;

				expect(result).to.eql("Dynamoose Warning: Passing callback function into transaction method not allowed. Removing callback function from list of arguments.");
			});
		});
	});

	describe("Serializer", () => {
		let User;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String, "friend": {"type": Object, "schema": {"id": Number, "name": String}}});
		});
		afterEach(() => {
			User = null;
		});

		describe("Model.serializer", () => {
			it("Should be an instance of Serializer", () => {
				expect(User.serializer).to.be.an.instanceOf(require("../../dist/Serializer").Serializer);
			});

			describe("Model.serializer.add", () => {
				it("Should be a function", () => {
					expect(User.serializer.add).to.be.a("function");
				});

				it("Should throw an error if calling with no parameters", () => {
					expect(() => User.serializer.add()).to.throw("Field name is required and should be of type string");
				});

				it("Should throw an error if calling with object as first parameter", () => {
					expect(() => User.serializer.add({})).to.throw("Field name is required and should be of type string");
				});

				it("Should throw an error if calling with number as first parameter", () => {
					expect(() => User.serializer.add(1)).to.throw("Field name is required and should be of type string");
				});

				it("Should throw an error if calling with only first parameter", () => {
					expect(() => User.serializer.add("mySerializer")).to.throw("Field options is required and should be an object or array");
				});

				it("Should throw an error if calling with string as second parameter", () => {
					expect(() => User.serializer.add("mySerializer", "hello world")).to.throw("Field options is required and should be an object or array");
				});

				it("Should throw an error if calling with number as second parameter", () => {
					expect(() => User.serializer.add("mySerializer", 1)).to.throw("Field options is required and should be an object or array");
				});
			});

			describe("Model.serializer.delete", () => {
				it("Should be a function", () => {
					expect(User.serializer.delete).to.be.a("function");
				});

				it("Should throw an error if calling with no parameters", () => {
					expect(() => User.serializer.delete()).to.throw("Field name is required and should be of type string");
				});

				it("Should throw an error if calling with number as first parameter", () => {
					expect(() => User.serializer.delete(1)).to.throw("Field name is required and should be of type string");
				});

				it("Should throw an error if trying to delete primary default serializer", () => {
					expect(() => User.serializer.delete("_default")).to.throw("Can not delete primary default serializer");
				});
			});

			describe("Model.serializer.default.set", () => {
				it("Should be a function", () => {
					expect(User.serializer.default.set).to.be.a("function");
				});

				it("Should throw an error if calling with number as first parameter", () => {
					expect(() => User.serializer.default.set(1)).to.throw("Field name is required and should be of type string");
				});
			});
		});

		const serializeTests = [
			{"input": [[]], "output": []},
			{"input": [], "output": []},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]], "output": [{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], ["name"]], "output": [{"name": "Bob"}, {"name": "Tim"}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], ["id"]], "output": [{"id": 1}, {"id": 2}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], {"include": ["name"]}], "output": [{"name": "Bob"}, {"name": "Tim"}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], {"include": ["id"]}], "output": [{"id": 1}, {"id": 2}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], {"exclude": ["name"]}], "output": [{"id": 1}, {"id": 2}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], {"exclude": ["id"]}], "output": [{"name": "Bob"}, {"name": "Tim"}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], {"exclude": ["id", "name"]}], "output": [{}, {}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], {"include": []}], "output": [{}, {}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], {"exclude": ["id"], "include": ["id"]}], "output": [{}, {}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], {"exclude": ["id"], "include": ["id", "name"]}], "output": [{"name": "Bob"}, {"name": "Tim"}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], {"exclude": ["name"], "include": ["id", "name"]}], "output": [{"id": 1}, {"id": 2}]},
			{"input": [[{"id": 1, "name": "Bob", "friend": {"id": 3, "name": "Tom"}}, {"id": 2, "name": "Tim", "friend": {"id": 3, "name": "Tom"}}], {"exclude": ["friend"]}], "output": [{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]},
			{"input": [[{"id": 1, "name": "Bob", "friend": {"id": 3, "name": "Tom"}}, {"id": 2, "name": "Tim", "friend": {"id": 3, "name": "Tom"}}], {"exclude": ["friend.id"]}], "output": [{"id": 1, "name": "Bob", "friend": {"name": "Tom"}}, {"id": 2, "name": "Tim", "friend": {"name": "Tom"}}]},
			{"input": [[{"id": 1, "name": "Bob", "friend": {"id": 3, "name": "Tom"}}, {"id": 2, "name": "Tim", "friend": {"id": 3, "name": "Tom"}}], {"include": ["friend.name"]}], "output": [{"friend": {"name": "Tom"}}, {"friend": {"name": "Tom"}}]},
			{"input": () => {
				User.serializer.add("mySerializer", ["name"]);
				return [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], "mySerializer"];
			}, "output": [{"name": "Bob"}, {"name": "Tim"}]},
			{"input": () => {
				User.serializer.add("mySerializer", ["id"]);
				return [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], "mySerializer"];
			}, "output": [{"id": 1}, {"id": 2}]},
			{"input": () => {
				User.serializer.add("mySerializer", ["id"]);
				User.serializer.default.set("mySerializer");
				return [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]];
			}, "output": [{"id": 1}, {"id": 2}]},
			{"input": () => {
				User.serializer.add("mySerializer", ["id"]);
				User.serializer.default.set("mySerializer");
				User.serializer.default.set();
				return [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]];
			}, "output": [{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]},
			{"input": () => {
				User.serializer.add("mySerializer", ["id"]);
				User.serializer.default.set("random");
				return [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]];
			}, "output": [{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]},
			{"input": () => {
				User.serializer.add("mySerializer", ["id"]);
				User.serializer.delete("mySerializer");
				return [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], "mySerializer"];
			}, "error": "Field options is required and should be an object or array"},
			{"input": () => {
				User.serializer.add("mySerializer", ["id"]);
				User.serializer.delete("random");
				return [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]];
			}, "output": [{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]},
			{"input": () => {
				User.serializer.add("mySerializer", ["id"]);
				User.serializer.default.set("mySerializer");
				User.serializer.delete("mySerializer");
				return [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]];
			}, "output": [{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}]},
			{"input": () => {
				User.serializer.add("isActive", {
					"modify": (serialized, original) => {
						serialized.isActive = original.status === "active";
						return serialized;
					}
				});
				return [[{"id": 1, "status": "active", "name": "Bob"}, {"id": 2, "status": "not_active", "name": "Tim"}], "isActive"];
			}, "output": [{"id": 1, "status": "active", "isActive": true, "name": "Bob"}, {"id": 2, "status": "not_active", "isActive": false, "name": "Tim"}]},
			{"input": () => {
				User.serializer.add("isActive", {
					"exclude": ["status"],
					"modify": (serialized, original) => {
						serialized.isActive = original.status === "active";
						return serialized;
					}
				});
				return [[{"id": 1, "status": "active", "name": "Bob"}, {"id": 2, "status": "not_active", "name": "Tim"}], "isActive"];
			}, "output": [{"id": 1, "isActive": true, "name": "Bob"}, {"id": 2, "isActive": false, "name": "Tim"}]},
			{"input": () => {
				User.serializer.add("isActive", {
					"include": ["id"],
					"modify": (serialized, original) => {
						serialized.isActive = original.status === "active";
						return serialized;
					}
				});
				return [[{"id": 1, "status": "active", "name": "Bob"}, {"id": 2, "status": "not_active", "name": "Tim"}], "isActive"];
			}, "output": [{"id": 1, "isActive": true}, {"id": 2, "isActive": false}]},
			{"input": [[{"id": 1, "name": "Bob"}, {"id": 2, "name": "Tim"}], "random"], "error": "Field options is required and should be an object or array"},
			{"input": [{"id": 1, "name": "Bob"}], "error": "documentsArray must be an array of document objects"}
		];
		describe("Model.serializeMany", () => {
			it("Should be a function", () => {
				expect(User.serializeMany).to.be.a("function");
			});

			serializeTests.forEach((test) => {
				it(`Should return ${JSON.stringify(test.output)} for ${JSON.stringify(test.input)}`, () => {
					const input = typeof test.input === "function" ? test.input() : test.input;
					if (test.error) {
						expect(() => User.serializeMany(...input)).to.throw(test.error);
					} else {
						expect(User.serializeMany(...input)).to.eql(test.output);
					}
				});

				it(`Should return ${JSON.stringify(test.output)} for ${JSON.stringify(test.input)} when using document instance`, () => {
					const input = typeof test.input === "function" ? test.input() : test.input;
					if (Array.isArray(input[0])) {
						input[0] = input[0].map((obj) => new User(obj));
					}

					if (test.error) {
						expect(() => User.serializeMany(...input)).to.throw(test.error);
					} else {
						expect(User.serializeMany(...input)).to.eql(test.output);
					}
				});
			});
		});

		describe("model.serialize", () => {
			it("Should be a function", () => {
				expect(new User().serialize).to.be.a("function");
			});

			serializeTests.forEach((test) => {
				it(`Should return ${JSON.stringify(test.output)} for ${JSON.stringify(test.input)}`, () => {
					const input = typeof test.input === "function" ? test.input() : test.input;

					if (Array.isArray(input[0])) {
						input[0].forEach((object, index) => {
							const document = new User(object);

							if (test.error) {
								expect(() => document.serialize(input[1])).to.throw(test.error);
							} else {
								expect(document.serialize(input[1])).to.eql(test.output[index]);
							}
						});
					}
				});

				if (!test.error) {
					it(`Should return same output as document.toJSON() for ${JSON.stringify(test.input)}`, () => {
						const input = typeof test.input === "function" ? test.input() : test.input;

						if (Array.isArray(input[0])) {
							input[0].forEach((object) => {
								const document = new User(object);
								User.serializer.default.set();
								expect(document.serialize()).to.eql(document.toJSON());
							});
						}
					});
				}
			});
		});
	});

	describe("Model.methods", () => {
		let User, user;
		beforeEach(() => {
			User = dynamoose.model("User", {"id": Number, "name": String});
			user = new User();
		});
		afterEach(() => {
			User = null;
			user = null;
		});

		it("Should be an object", () => {
			expect(User.methods).to.be.an("object");
		});

		function customMethodTests (settings) {
			describe(`${settings.prefixName}.set`, () => {
				it("Should be a function", () => {
					expect(settings.methodEntryPoint().set).to.be.a("function");
				});

				it("Should not throw an error when being called", () => {
					expect(() => settings.methodEntryPoint().set("random", utils.empty_function)).to.not.throw();
				});

				it("Should set correct method on model", () => {
					settings.methodEntryPoint().set("random", utils.empty_function);
					expect(settings.testObject().random).to.be.a("function");
				});

				it("Should not overwrite internal methods", () => {
					const originalMethod = settings.testObject()[settings.existingMethod];
					const newMethod = utils.empty_function;
					settings.methodEntryPoint().set(settings.existingMethod, newMethod);
					expect(settings.testObject()[settings.existingMethod]).to.eql(originalMethod);
					expect(settings.testObject()[settings.existingMethod]).to.not.eql(newMethod);
				});

				it("Should overwrite methods if Internal.General.internalProperties exists but type doesn't", () => {
					const originalMethod = settings.testObject()[settings.existingMethod];
					const newMethod = utils.empty_function;
					settings.testObject().random = originalMethod;
					settings.testObject().random[Internal.General.internalProperties] = {};
					settings.methodEntryPoint().set(settings.existingMethod, newMethod);
					expect(settings.testObject().random).to.eql(originalMethod);
					expect(settings.testObject().random).to.not.eql(newMethod);
				});

				const methodTypes = [
					{"name": "Callback", "func": (func) => {
						return function (...args) {
							const cb = args[args.length - 1];
							func.bind(this)(...args).then((result) => cb(null, result)).catch((err) => cb(err));
						};
					}},
					{"name": "Promise", "func": (func) => func}
				];
				methodTypes.forEach((methodType) => {
					describe(`Method Type - ${methodType.name}`, () => {
						const callerTypes = [
							{"name": "Callback", "func": util.promisify},
							{"name": "Promise", "func": (func) => func}
						];
						callerTypes.forEach((callerType) => {
							describe(`Caller Type - ${callerType.name}`, () => {
								let methodTypeCallDetails = [], methodTypeCallResult = {};
								beforeEach(() => {
									settings.methodEntryPoint().set("action", methodType.func(async function (...args) {
										methodTypeCallDetails.push({"arguments": [...args], "this": this});
										if (methodTypeCallResult.error) {
											throw methodTypeCallResult.error;
										} else if (methodTypeCallResult.result) {
											return methodTypeCallResult.result;
										}
									}));
								});
								afterEach(() => {
									methodTypeCallDetails = [];
									methodTypeCallResult = {};
								});

								it("Should call custom method with correct arguments", async () => {
									methodTypeCallResult.result = "Success";
									await callerType.func(settings.testObject().action)();
									expect(methodTypeCallDetails.length).to.eql(1);
									expect(methodTypeCallDetails[0].arguments.length).to.eql(1);
									expect(methodTypeCallDetails[0].arguments[0]).to.be.a("function");
								});

								it("Should call custom method with correct arguments if passing in one argument", async () => {
									await callerType.func(settings.testObject().action)("Hello World");
									expect(methodTypeCallDetails.length).to.eql(1);
									expect(methodTypeCallDetails[0].arguments.length).to.eql(2);
									expect(methodTypeCallDetails[0].arguments[0]).to.eql("Hello World");
									expect(methodTypeCallDetails[0].arguments[1]).to.be.a("function");
								});

								it("Should call custom method with correct arguments if passing in two arguments", async () => {
									await callerType.func(settings.testObject().action)("Hello", "World");
									expect(methodTypeCallDetails.length).to.eql(1);
									expect(methodTypeCallDetails[0].arguments.length).to.eql(3);
									expect(methodTypeCallDetails[0].arguments[0]).to.eql("Hello");
									expect(methodTypeCallDetails[0].arguments[1]).to.eql("World");
									expect(methodTypeCallDetails[0].arguments[2]).to.be.a("function");
								});

								it("Should call custom method with correct `this`", async () => {
									methodTypeCallResult.result = "Success";
									// Not sure why we have to bind here
									// Through manual testing tho, you do not need to bind anything and in production use this works as described in the documentation
									// Would be nice to figure out why this is only necessary for our test suite and fix it
									await callerType.func(settings.testObject().action).bind(settings.testObject())();
									expect(methodTypeCallDetails[0].this).to.eql(settings.testObject());
								});

								it("Should return correct response that custom method returns", async () => {
									methodTypeCallResult.result = "Success";
									const result = await callerType.func(settings.testObject().action)();
									expect(result).to.eql("Success");
								});

								it("Should throw error if custom method throws error", async () => {
									methodTypeCallResult.error = "ERROR";
									let result, error;
									try {
										result = await callerType.func(settings.testObject().action)();
									} catch (e) {
										error = e;
									}
									expect(result).to.not.exist;
									expect(error).to.eql("ERROR");
								});
							});
						});
					});
				});
			});
			describe(`${settings.prefixName}.delete`, () => {
				it("Should be a function", () => {
					expect(settings.methodEntryPoint().delete).to.be.a("function");
				});

				it("Should not delete internal methods", () => {
					settings.methodEntryPoint().delete(settings.existingMethod);
					expect(settings.testObject()[settings.existingMethod]).to.be.a("function");
				});

				it("Should not throw error for deleting unknown method", () => {
					expect(() => settings.methodEntryPoint().delete("randomHere123")).to.not.throw();
				});

				it("Should delete custom method", () => {
					settings.methodEntryPoint().set("myMethod", utils.empty_function);
					expect(settings.testObject().myMethod).to.be.a("function");
					settings.methodEntryPoint().delete("myMethod");
					expect(settings.testObject().myMethod).to.eql(undefined);
				});
			});
		}

		customMethodTests({"prefixName": "Model.methods", "methodEntryPoint": () => User.methods, "testObject": () => User, "existingMethod": "get"});
		describe("Model.methods.document", () => {
			customMethodTests({"prefixName": "Model.methods.document", "methodEntryPoint": () => User.methods.document, "testObject": () => user, "existingMethod": "save"});
		});
	});
});

describe("model", () => {
	beforeEach(() => {
		dynamoose.model.defaults.set({"create": false, "waitForActive": false});
	});
	afterEach(() => {
		dynamoose.model.defaults.set({});
	});

	let Cat;
	beforeEach(() => {
		const schema = new dynamoose.Schema({"name": String});
		Cat = dynamoose.model("Cat", schema);
	});

	it("Should allow creating instance of Model", () => {
		expect(() => new Cat({"name": "Bob"})).to.not.throw();
	});
});
