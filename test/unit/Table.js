const {expect} = require("chai");
const dynamoose = require("../../dist");
const Internal = require("../../dist/Internal");
const utils = require("../../dist/utils");
const {internalProperties} = Internal.General;

describe("Table", () => {
	beforeEach(() => {
		dynamoose.Table.defaults.set({"create": false, "waitForActive": false});
	});
	afterEach(() => {
		dynamoose.Table.defaults.set({});
	});

	it("Should be a function", () => {
		expect(dynamoose.Table).to.be.a("function");
	});

	describe("Initialization", () => {
		it("Should throw an error if not using `new` keyword", () => {
			expect(() => dynamoose.Table()).to.throw("Class constructor Table cannot be invoked without 'new'");
		});

		it("Should throw an error if nothing passed in", () => {
			expect(() => new dynamoose.Table()).to.throw("Name must be passed into table constructor.");
		});

		it("Should throw an error if number passed in as first argument", () => {
			expect(() => new dynamoose.Table(1)).to.throw("Name passed into table constructor should be of type string.");
		});

		it("Should throw an error if nothing passed into second argument", () => {
			expect(() => new dynamoose.Table("Table")).to.throw("Models must be passed into table constructor.");
		});

		it("Should throw an error if number passed into second argument", () => {
			expect(() => new dynamoose.Table("Table", 1)).to.throw("Models passed into table constructor should be an array of models.");
		});

		it("Should throw an error if array of strings passed into second arguemnt", () => {
			expect(() => new dynamoose.Table("Table", ["hello", "world"])).to.throw("Models passed into table constructor should be an array of models.");
		});

		it("Should throw an error if empty array passed into second arguemnt", () => {
			expect(() => new dynamoose.Table("Table", [])).to.throw("Models passed into table constructor should be an array of models.");
		});

		it("Should succeed if constructing table correctly", () => {
			new dynamoose.Table("Table", [dynamoose.model("User", {"id": String})], {"create": false, "waitForActive": false});
			expect(() => new dynamoose.Table("Table", [dynamoose.model("User", {"id": String})], {"create": false, "waitForActive": false})).to.not.throw();
		});

		describe("Prefixes and Suffixes", () => {
			const optionsB = [
				{"name": "Prefix", "value": "prefix", "check": (val, result) => expect(result).to.match(new RegExp(`^${val}`))},
				{"name": "Suffix", "value": "suffix", "check": (val, result) => expect(result).to.match(new RegExp(`${val}$`))}
			];
			const optionsC = [
				{"name": "Defaults", "func": (type, value, ...args) => {
					dynamoose.Table.defaults.set({...dynamoose.Table.defaults.get(), [type]: value});
					const model = dynamoose.model(...args);
					return new dynamoose.Table(args[0], [model]);
				}},
				{"name": "Options", "func": (type, value, ...args) => new dynamoose.Table(args[0], [dynamoose.model(...args)], {[type]: value})}
			];
			optionsB.forEach((optionB) => {
				describe(optionB.name, () => {
					optionsC.forEach((optionC) => {
						describe(optionC.name, () => {
							it("Should result in correct table name", () => {
								const extension = "MyApp";
								const tableName = "Users";
								const table = optionC.func(optionB.value, extension, tableName, {"id": String});
								expect(table.name).to.include(extension);
								expect(table.name).to.not.eql(tableName);
							});
						});
					});
				});
			});
		});

		describe("Table.ready", () => {
			it("Should not be ready to start", () => {
				const Model = dynamoose.model("Cat", {"id": String});
				const Table = new dynamoose.Table("Cat", [Model], {"create": false});
				expect(Table[internalProperties].ready).to.be.false;
			});

			it("Should set ready after setup flow", async () => {
				const Model = dynamoose.model("Cat", {"id": String});
				const Table = new dynamoose.Table("Cat", [Model], {"create": false, "waitForActive": false});
				await utils.set_immediate_promise();
				expect(Table[internalProperties].ready).to.be.true;
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
				const Model = dynamoose.model("Cat", {"id": String});
				const Table = new dynamoose.Table("Cat", [Model], {"waitForActive": {"enabled": true, "check": {"frequency": 0}}});

				await utils.set_immediate_promise();

				let pendingTaskPromiseResolved = false;
				Table[internalProperties].pendingTaskPromise().then(() => pendingTaskPromiseResolved = true);

				await utils.set_immediate_promise();
				expect(pendingTaskPromiseResolved).to.be.false;

				describeTableResponse = {
					"Table": {"TableStatus": "ACTIVE"}
				};
				await Table[internalProperties].pendingTaskPromise();
				await utils.set_immediate_promise();
				expect(pendingTaskPromiseResolved).to.be.true;
				expect(Table[internalProperties].pendingTasks).to.eql([]);
			});

			it("Should immediately resolve pendingTaskPromises promise if table is already ready", async () => {
				const Model = dynamoose.model("Cat", {"id": String});
				const Table = new dynamoose.Table("Cat", [Model], {"create": false});
				await utils.set_immediate_promise();

				let pendingTaskPromiseResolved = false;
				Table[internalProperties].pendingTaskPromise().then(() => pendingTaskPromiseResolved = true);

				await utils.set_immediate_promise();

				expect(pendingTaskPromiseResolved).to.be.true;
			});
		});

		describe("Creation", () => {
			let createTableParams = null;
			beforeEach(() => {
				dynamoose.Table.defaults.set({
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model]);
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model], {"throughput": 1});
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model], {"throughput": {"read": 2, "write": 3}});
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model], {"throughput": "ON_DEMAND"});
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model]);
				await utils.set_immediate_promise();
				expect(createTableParams).to.eql(null);
			});

			it("Should not call createTable if create option set to false", async () => {
				const model = dynamoose.model("Cat", {"id": String});
				new dynamoose.Table("Cat", [model], {"create": false});
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

				const model = dynamoose.model("Cat", {"id": String});
				new dynamoose.Table("Cat", [model]);
				await utils.set_immediate_promise();
				expect(self).to.be.an("object");
				expect(Object.keys(self)).to.eql(["promise"]);
				expect(self.promise).to.exist;
			});
		});

		describe("Wait For Active", () => {
			let describeTableParams = [], describeTableFunction;
			beforeEach(() => {
				dynamoose.Table.defaults.set({
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
				dynamoose.aws.ddb.set({
					"describeTable": (params) => {
						describeTableParams.push(params);
						return {
							"promise": () => describeTableFunction(params)
						};
					}
				});
			});
			afterEach(() => {
				describeTableParams = [];
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model]);
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model]);
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model]);
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model]);
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

				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model], {"create": true});
				await utils.timeout(5);
				expect(describeTableParams).to.eql([{
					"TableName": tableName
				}]);
			});
		});

		describe("Update", () => {
			let describeTableFunction, updateTableParams = [];
			beforeEach(() => {
				dynamoose.Table.defaults.set({
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
							const model = dynamoose.model(tableName, {"id": String});
							new dynamoose.Table(tableName, [model], {"throughput": {"read": 1, "write": 2}, "update": updateOption});
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
							const model = dynamoose.model(tableName, {"id": String});
							new dynamoose.Table(tableName, [model], {"throughput": "ON_DEMAND", "update": updateOption});
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
							const model = dynamoose.model(tableName, {"id": String});
							new dynamoose.Table(tableName, [model], {"throughput": 5, "update": updateOption});
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
							const model = dynamoose.model(tableName, {"id": String, "name": {"type": String, "index": {"global": true}}});
							new dynamoose.Table(tableName, [model], {"update": updateOption});
							await model.Model[internalProperties].table()[internalProperties].pendingTaskPromise();
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
							const model = dynamoose.model(tableName, {"id": String, "name": {"type": String}});
							new dynamoose.Table(tableName, [model], {"update": updateOption});
							await model.Model[internalProperties].table()[internalProperties].pendingTaskPromise();
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
							const model = dynamoose.model(tableName, {"id": String, "name": {"type": String, "index": {"global": true}}, "status": {"type": String, "index": {"global": true}}});
							new dynamoose.Table(tableName, [model], {"update": updateOption});
							await model.Model[internalProperties].table()[internalProperties].pendingTaskPromise();
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
				dynamoose.Table.defaults.set({
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model], {"expires": 1000});
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model], {"expires": {"ttl": 1000, "attribute": "expires"}});
				await model.Model[internalProperties].table()[internalProperties].pendingTaskPromise();
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
				const model = dynamoose.model(tableName, {"id": String});
				new dynamoose.Table(tableName, [model], {"expires": {"ttl": 1000, "attribute": "expires"}});
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

	describe("table.name", () => {
		const tests = [
			{"name": "No options", "options": {}, "input": "Table", "output": "Table"},
			{"name": "Prefix", "options": {"prefix": "MyApp_"}, "input": "Table", "output": "MyApp_Table"},
			{"name": "Suffix", "options": {"suffix": "_Table"}, "input": "User", "output": "User_Table"}
		];

		tests.forEach((test) => {
			describe(test.name, () => {
				it("Should return correct value", () => {
					const table = new dynamoose.Table(test.input, [dynamoose.model("Cat", {"id": String})], test.options);
					expect(table.name).to.eql(test.output);
				});
			});
		});

		it("Should not be able to set", () => {
			const table = new dynamoose.Table("Table", [dynamoose.model("Cat", {"id": String})]);
			table.name = "RandomString";
			expect(table.name).to.eql("Table");
		});
	});

	describe("table.create()", () => {
		it("Should be a function", () => {
			const model = dynamoose.model("User", {"id": String});
			const table = new dynamoose.Table("User", [model]);
			expect(table.create).to.be.a("function");
		});

		it("Should return correct result", async () => {
			const model = dynamoose.model("User", {"id": String});
			const table = new dynamoose.Table("User", [model]);
			expect(await table.create({"return": "request"})).to.eql({
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
			const model = dynamoose.model("User", {"id": [String, Number]});
			const table = new dynamoose.Table("User", [model]);

			return expect(table.create({"return": "request"})).to.eventually.rejectedWith("You can not have multiple types for attribute definition: id.");
		});

		it("Should reject if has multiple types for rangeKey", () => {
			const model = dynamoose.model("User", {"id": String, "rangeKey": {"type": [String, Number], "rangeKey": true}});
			const table = new dynamoose.Table("User", [model]);

			return expect(table.create({"return": "request"})).to.eventually.rejectedWith("You can not have multiple types for attribute definition: rangeKey.");
		});
	});
});
