const {expect} = require("chai");
const dynamoose = require("../../dist");
const Error = require("../../dist/Error");

describe("Schema", () => {
	it("Should be a function", () => {
		expect(dynamoose.Schema).to.be.a("function");
	});

	it("Should throw an error if not using `new` keyword", () => {
		expect(() => dynamoose.Schema()).to.throw("Class constructor Schema cannot be invoked without 'new'");
	});

	it("Should throw an error if nothing passed in", () => {
		expect(() => new dynamoose.Schema()).to.throw("Schema initalization parameter must be an object.");
	});

	it("Should throw an error if empty object passed in", () => {
		expect(() => new dynamoose.Schema({})).to.throw("Schema initalization parameter must not be an empty object.");
	});

	it("Shouldn't throw an error if object passed in", () => {
		expect(() => new dynamoose.Schema({"id": String})).to.not.throw();
	});

	it("Should set correct settings value", () => {
		expect(new dynamoose.Schema({"id": String}, {"saveUnknown": true}).settings).to.eql({"saveUnknown": true});
	});

	it("Should set correct settings value default value of empty object", () => {
		expect(new dynamoose.Schema({"id": String}).settings).to.eql({});
	});

	it("Should throw error if timestamps already exists in schema", () => {
		expect(() => new dynamoose.Schema({"id": String, "createdAt": Date, "updatedAt": Date}, {"timestamps": true}).settings).to.throw("Timestamp attributes must not be defined in schema.");
		expect(() => new dynamoose.Schema({"id": String, "created": Date, "updated": Date}, {"timestamps": {"createdAt": "created", "updatedAt": "updated"}}).settings).to.throw("Timestamp attributes must not be defined in schema.");
		expect(() => new dynamoose.Schema({"id": String, "a1": Date, "b1": Date}, {"timestamps": {"createdAt": ["created", "a1"], "updatedAt": ["updated", "b1"]}}).settings).to.throw("Timestamp attributes must not be defined in schema.");
	});

	it("Should throw error if passing multiple schema elements into array", () => {
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Array, "schema": [String, Number]}})).to.throw("You must only pass one element into schema array.");
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Array, "schema": [{"type": Object, "schema": {"name": String, "data": {"type": Array, "schema": [Buffer, String]}}}]}})).to.throw("You must only pass one element into schema array.");
	});

	it("Should not throw error if passing only one element into schema elements array", () => {
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Array, "schema": [String]}})).to.not.throw();
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Array, "schema": [{"type": Object, "schema": {"name": String, "data": {"type": Array, "schema": [String]}}}]}})).to.not.throw();
	});

	it("Should throw error if attribute names contain dots", () => {
		expect(() => new dynamoose.Schema({"id.data": String})).to.throw("Attributes must not contain dots.");
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Array, "schema": [{"type": Object, "schema": {"name.other": String, "data": {"type": Array, "schema": [Buffer, String]}}}]}})).to.throw("Attributes must not contain dots.");
	});

	it("Should throw error if attribute is both hashKey and rangeKey", () => {
		expect(() => new dynamoose.Schema({"id": String, "friend": {"type": String, "hashKey": true, "rangeKey": true}})).to.throw("Attribute friend must not be both hashKey and rangeKey");
	});

	it("Should throw error if using hashKey as nested attribute", () => {
		expect(() => new dynamoose.Schema({"id": String, "friend": {"type": Object, "schema": {"name": {"type": String, "hashKey": true}}}})).to.throw("hashKey must be at root object and not nested in object or array.");
	});

	it("Should throw error if using multiple hashKey's'", () => {
		expect(() => new dynamoose.Schema({"id": String, "attr1": {"type": String, "hashKey": true}, "attr2": {"type": String, "hashKey": true}})).to.throw("Only one hashKey allowed per schema.");
	});

	it("Should throw error if using rangeKey as nested attribute", () => {
		expect(() => new dynamoose.Schema({"id": String, "friend": {"type": Object, "schema": {"name": {"type": String, "rangeKey": true}}}})).to.throw("rangeKey must be at root object and not nested in object or array.");
	});

	it("Should throw error if using multiple rangeKeys's'", () => {
		expect(() => new dynamoose.Schema({"id": String, "attr1": {"type": String, "rangeKey": true}, "attr2": {"type": String, "rangeKey": true}})).to.throw("Only one rangeKey allowed per schema.");
	});

	it("Should throw error if using index as nested attribute", () => {
		expect(() => new dynamoose.Schema({"id": String, "friend": {"type": Object, "schema": {"name": {"type": String, "index": {"global": true}}}}})).to.throw("Index must be at root object and not nested in object or array.");
	});

	it("Should throw error if passing an index with multiple data types", () => {
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Object, "schema": {"names": [{"type": Array, "schema": [String]}, {"type": String, "index": true}]}}})).to.throw("Index must be at root object and not nested in object or array.");
	});

	it("Should not throw error if passing multiple data types for a nested array attribute", () => {
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Object, "schema": {"names": [{"type": Array, "schema": [String]}, {"type": Array, "schema": [Number]}]}}})).to.not.throw();
	});

	it.skip("Should throw error if attribute names only contains number", () => {
		expect(() => new dynamoose.Schema({"1": String})).to.throw("Attributes names must not be numbers.");
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Array, "schema": [{"type": Object, "schema": {"1": String, "data": {"type": Array, "schema": [Buffer, String]}}}]}})).to.throw("Attributes names must not be numbers.");
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Array, "schema": [{"type": Object, "schema": {"1": {"type": Set, "schema": [String]}, "data": {"type": Array, "schema": [Buffer, String]}}}]}})).to.throw("Attributes names must not be numbers.");
	});

	it.skip("Should throw error if attribute names contains star", () => {
		expect(() => new dynamoose.Schema({"*": String})).to.throw("Attributes names must not include stars.");
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Array, "schema": [{"type": Object, "schema": {"*": String, "data": {"type": Array, "schema": [Buffer, String]}}}]}})).to.throw("Attributes names must not include stars.");
		expect(() => new dynamoose.Schema({"id": String, "friends": {"type": Array, "schema": [{"type": Object, "schema": {"*": {"type": Set, "schema": [String]}, "data": {"type": Array, "schema": [Buffer, String]}}}]}})).to.throw("Attributes names must not include stars.");
	});

	it("Should not throw error if valid schema passed in", () => {
		expect(() => new dynamoose.Schema({"id": Number, "friends": {"type": Set, "schema": [String]}})).to.not.throw();
	});

	describe("Nested Schemas", () => {
		it("Should have correct schemaObject for nested schemas", () => {
			expect(new dynamoose.Schema({"id": Number, "parent": new dynamoose.Schema({"name": String})}).schemaObject).to.eql({
				"id": Number,
				"parent": {
					"type": Object,
					"schema": {
						"name": String
					}
				}
			});
		});

		it("Should have correct schemaObject for nested schemas when defined as schema", () => {
			expect(new dynamoose.Schema({"id": Number, "parent": {"type": Object, "schema": new dynamoose.Schema({"name": String})}}).schemaObject).to.eql({
				"id": Number,
				"parent": {
					"type": Object,
					"schema": {
						"name": String
					}
				}
			});
		});

		it("Should have correct schemaObject for nested schemas when defined as schema and other settings", () => {
			expect(new dynamoose.Schema({"id": Number, "parent": {"type": Object, "schema": new dynamoose.Schema({"name": String}), "required": true}}).schemaObject).to.eql({
				"id": Number,
				"parent": {
					"type": Object,
					"schema": {
						"name": String
					},
					"required": true
				}
			});
		});

		it("Should have correct schemaObject for nested schemas as array", () => {
			expect(new dynamoose.Schema({"id": Number, "parents": {"type": Array, "schema": [new dynamoose.Schema({"name": String})]}}).schemaObject).to.eql({
				"id": Number,
				"parents": {
					"type": Array,
					"schema": [{
						"type": Object,
						"schema": {
							"name": String
						}
					}]
				}
			});
		});

		it("Should have correct schemaObject for nested schemas as array and other settings", () => {
			expect(new dynamoose.Schema({"id": Number, "parents": {"type": Array, "schema": [new dynamoose.Schema({"name": String})], "required": true}}).schemaObject).to.eql({
				"id": Number,
				"parents": {
					"type": Array,
					"schema": [{
						"type": Object,
						"schema": {
							"name": String
						}
					}],
					"required": true
				}
			});
		});
	});

	describe("getAttributeType", () => {
		const schemas = [
			{
				"name": "JS Types",
				"collection": 1,
				"schema": {
					"id": String,
					"name": String,
					"age": Number,
					"happy": Boolean,
					"birthday": Date,
					"metadata": Object,
					"friends": Array,
					"picture": Buffer,
					"data": [String, Buffer],
					"dataArray": [{"type": Array, "schema": [String]}, {"type": Array, "schema": [Buffer]}],
					"randomArray": [{"type": Object, "schema": {"name": String}}, {"type": Array, "schema": [Buffer]}],
					"favoriteFoods": {"type": Set, "schema": [String]},
					"favoriteNumbers": {"type": Set, "schema": [Number]},
					"favoriteDates": {"type": Set, "schema": [Date]},
					"favoritePictures": {"type": Set, "schema": [Buffer]},
					"favoriteTypes": {"type": Set, "schema": [Boolean]},
					"favoriteObjects": {"type": Set, "schema": [Object]},
					"favoriteFriends": {"type": Set, "schema": [Array]},
					"emptyItem": Symbol,
					"emptyItems": {"type": Set, "schema": [Symbol]}
				}
			},
			{
				"name": "String Types",
				"collection": 2,
				"schema": {
					"id": "String",
					"name": "string",
					"age": "NUMBER",
					"happy": "boolean",
					"birthday": "DaTe",
					"metadata": "objECT",
					"friends": "ARRay",
					"picture": "buffer",
					"data": ["String", "Buffer"],
					"dataArray": [{"type": "Array", "schema": ["String"]}, {"type": "Array", "schema": ["Buffer"]}],
					"randomArray": [{"type": "Object", "schema": {"name": "String"}}, {"type": "Array", "schema": ["Buffer"]}]
				}
			}
		];
		const tests = [
			{"input": undefined, "output": undefined},
			{"input": null, "output": undefined},
			{"input": "random", "output": undefined},
			{"input": "id", "output": "S"},
			{"input": "name", "output": "S"},
			{"input": "age", "output": "N"},
			{"input": "happy", "output": "BOOL"},
			{"input": "birthday", "output": "N"},
			{"input": "metadata", "output": "M"},
			{"input": "friends", "output": "L"},
			{"input": "picture", "output": "B"},
			{"input": "data", "output": ["S", "B"]},
			{"input": "dataArray", "output": ["L", "L"]},
			{"input": "randomArray", "output": ["M", "L"]},
			{"input": "favoriteFoods", "output": "SS", "collection": 1},
			{"input": "favoriteNumbers", "output": "NS", "collection": 1},
			{"input": "favoriteDates", "output": "NS", "collection": 1},
			{"input": "favoritePictures", "output": "BS", "collection": 1},
			{"input": "favoriteTypes", "output": null, "collection": 1},
			{"input": "favoriteObjects", "output": null, "collection": 1},
			{"input": "favoriteFriends", "output": null, "collection": 1},
			{"input": "emptyItem", "output": null, "collection": 1},
			{"input": "emptyItems", "output": null, "collection": 1}
		];
		schemas.forEach((schemaObj) => {
			["standard", "objectTypes"].forEach((type) => {
				describe(`${schemaObj.name}${type === "objectTypes" ? " - Object Type" : ""}`, () => {
					let schema;
					beforeEach(() => {
						if (type === "standard") {
							schema = new dynamoose.Schema({...schemaObj.schema});
						} else {
							const schemaObject = {...schemaObj.schema};
							Object.keys(schemaObject).forEach((key) => {
								if (!schemaObject[key].schema) {
									schemaObject[key] = {"type": schemaObject[key]};
								}
							});
							schema = new dynamoose.Schema(schemaObject);
						}
					});

					tests.forEach((test) => {
						if (!test.collection || test.collection === schemaObj.collection) {
							if (!test.output) {
								it(`Should throw error for ${test.input}`, () => {
									expect(() => schema.getAttributeType(test.input)).to.throw();
								});
							} else {
								it(`Should return ${test.output} for ${test.input}`, () => {
									expect(schema.getAttributeType(test.input)).to.eql(test.output);
								});
							}
						}
					});
				});
			});
		});
	});

	describe("getHashKey", () => {
		it("Should return first attribute if no hash key defined", () => {
			expect(new dynamoose.Schema({"id": String, "age": Number}).getHashKey()).to.eql("id");
		});

		it("Should return hash key if set to true", () => {
			expect(new dynamoose.Schema({"id": String, "age": {"type": Number, "hashKey": true}}).getHashKey()).to.eql("age");
		});
	});

	describe("getRangeKey", () => {
		it("Should return undefined if no range key defined", () => {
			expect(new dynamoose.Schema({"id": String, "age": Number}).getRangeKey()).to.eql(undefined);
		});

		it("Should return range key if set to true", () => {
			expect(new dynamoose.Schema({"id": String, "age": {"type": Number, "rangeKey": true}}).getRangeKey()).to.eql("age");
		});
	});

	describe("getCreateTableAttributeParams", () => {
		const tests = [
			{
				"name": "Should return correct result with one attribute",
				"input": {"id": String},
				"output": {
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
				}
			},
			{
				"name": "Should return correct result with custom hash key",
				"input": {"id": String, "age": {"type": Number, "hashKey": true}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "age",
							"KeyType": "HASH"
						}
					]
				}
			},
			{
				"name": "Should return correct result with custom range key",
				"input": {"id": String, "age": {"type": Number, "rangeKey": true}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						},
						{
							"AttributeName": "age",
							"KeyType": "RANGE"
						}
					]
				}
			},
			{
				"name": "Should return correct result with custom range key and hash key",
				"input": {"id": {"type": String, "rangeKey": true}, "age": {"type": Number, "hashKey": true}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "age",
							"AttributeType": "N"
						},
						{
							"AttributeName": "id",
							"AttributeType": "S"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "age",
							"KeyType": "HASH"
						},
						{
							"AttributeName": "id",
							"KeyType": "RANGE"
						}
					]
				}
			},
			{
				"name": "Should return correct result with index as true",
				"input": {"id": String, "age": {"type": Number, "index": true}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"LocalSecondaryIndexes": [
						{
							"IndexName": "ageLocalIndex",
							"Projection": {
								"ProjectionType": "ALL"
							},
							"KeySchema": [
								{
									"AttributeName": "id",
									"KeyType": "HASH"
								},
								{
									"AttributeName": "age",
									"KeyType": "RANGE"
								}
							]
						}
					]
				}
			},
			{
				"name": "Should return correct result with index as true and multiple indexes",
				"input": {"id": String, "age": {"type": Number, "index": true}, "name": {"type": String, "index": true}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						},
						{
							"AttributeName": "name",
							"AttributeType": "S"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"LocalSecondaryIndexes": [
						{
							"IndexName": "ageLocalIndex",
							"Projection": {
								"ProjectionType": "ALL"
							},
							"KeySchema": [
								{
									"AttributeName": "id",
									"KeyType": "HASH"
								},
								{
									"AttributeName": "age",
									"KeyType": "RANGE"
								}
							]
						},
						{
							"IndexName": "nameLocalIndex",
							"Projection": {
								"ProjectionType": "ALL"
							},
							"KeySchema": [
								{
									"AttributeName": "id",
									"KeyType": "HASH"
								},
								{
									"AttributeName": "name",
									"KeyType": "RANGE"
								}
							]
						}
					]
				}
			},
			{
				"name": "Should return correct result with global index as object with just name",
				"input": {"id": String, "age": {"type": Number, "index": {"name": "ageIndex"}}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"LocalSecondaryIndexes": [
						{
							"IndexName": "ageIndex",
							"Projection": {
								"ProjectionType": "ALL"
							},
							"KeySchema": [
								{
									"AttributeName": "id",
									"KeyType": "HASH"
								},
								{
									"AttributeName": "age",
									"KeyType": "RANGE"
								}
							]
						}
					]
				}
			},
			{
				"name": "Should return correct result with global index as object",
				"input": {"id": String, "age": {"type": Number, "index": {"name": "ageIndex", "global": true, "rangeKey": "id", "project": true, "throughput": 5}}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"GlobalSecondaryIndexes": [
						{
							"IndexName": "ageIndex",
							"KeySchema": [
								{
									"AttributeName": "age",
									"KeyType": "HASH"
								},
								{
									"AttributeName": "id",
									"KeyType": "RANGE"
								}
							],
							"ProvisionedThroughput": {
								"ReadCapacityUnits": 5,
								"WriteCapacityUnits": 5
							},
							"Projection": {
								"ProjectionType": "ALL"
							}
						}
					]
				}
			},
			{
				"name": "Should return correct result with global index as object with rangeKey as different property",
				"input": {"id": String, "age": {"type": Number, "index": {"name": "ageIndex", "global": true, "rangeKey": "type", "project": true, "throughput": 5}}, "type": String},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						},
						{
							"AttributeName": "type",
							"AttributeType": "S"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"GlobalSecondaryIndexes": [
						{
							"IndexName": "ageIndex",
							"KeySchema": [
								{
									"AttributeName": "age",
									"KeyType": "HASH"
								},
								{
									"AttributeName": "type",
									"KeyType": "RANGE"
								}
							],
							"ProvisionedThroughput": {
								"ReadCapacityUnits": 5,
								"WriteCapacityUnits": 5
							},
							"Projection": {
								"ProjectionType": "ALL"
							}
						}
					]
				}
			},
			{
				"name": "Should return correct result with index and project as null",
				"input": {"id": String, "age": {"type": Number, "index": {"name": "ageIndex", "global": true, "project": null}}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"GlobalSecondaryIndexes": [
						{
							"IndexName": "ageIndex",
							"KeySchema": [
								{
									"AttributeName": "age",
									"KeyType": "HASH"
								}
							],
							"Projection": {
								"ProjectionType": "ALL"
							}
						}
					]
				}
			},
			{
				"name": "Should return correct result with index and project as true",
				"input": {"id": String, "age": {"type": Number, "index": {"name": "ageIndex", "global": true, "project": null}}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"GlobalSecondaryIndexes": [
						{
							"IndexName": "ageIndex",
							"KeySchema": [
								{
									"AttributeName": "age",
									"KeyType": "HASH"
								}
							],
							"Projection": {
								"ProjectionType": "ALL"
							}
						}
					]
				}
			},
			{
				"name": "Should return correct result with index and project as false",
				"input": {"id": String, "age": {"type": Number, "index": {"name": "ageIndex", "global": true, "project": false}}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"GlobalSecondaryIndexes": [
						{
							"IndexName": "ageIndex",
							"KeySchema": [
								{
									"AttributeName": "age",
									"KeyType": "HASH"
								}
							],
							"Projection": {
								"ProjectionType": "KEYS_ONLY"
							}
						}
					]
				}
			},
			{
				"name": "Should return correct result with index and project as array",
				"input": {"id": String, "age": {"type": Number, "index": {"name": "ageIndex", "global": true, "project": ["name"]}, "name": String, "address": String}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"GlobalSecondaryIndexes": [
						{
							"IndexName": "ageIndex",
							"KeySchema": [
								{
									"AttributeName": "age",
									"KeyType": "HASH"
								}
							],
							"Projection": {
								"NonKeyAttributes": ["name"],
								"ProjectionType": "INCLUDE"
							}
						}
					]
				}
			},
			{
				"name": "Should return correct result with index and no name as local index",
				"input": {"id": String, "age": {"type": Number, "index": {"name": ""}}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"LocalSecondaryIndexes": [
						{
							"IndexName": "ageLocalIndex",
							"KeySchema": [
								{
									"AttributeName": "id",
									"KeyType": "HASH"
								},
								{
									"AttributeName": "age",
									"KeyType": "RANGE"
								}
							],
							"Projection": {
								"ProjectionType": "ALL"
							}
						}
					]
				}
			},
			{
				"name": "Should return correct result with index and no name as global index",
				"input": {"id": String, "age": {"type": Number, "index": {"name": "", "global": true}}},
				"output": {
					"AttributeDefinitions": [
						{
							"AttributeName": "id",
							"AttributeType": "S"
						},
						{
							"AttributeName": "age",
							"AttributeType": "N"
						}
					],
					"KeySchema": [
						{
							"AttributeName": "id",
							"KeyType": "HASH"
						}
					],
					"GlobalSecondaryIndexes": [
						{
							"IndexName": "ageGlobalIndex",
							"KeySchema": [
								{
									"AttributeName": "age",
									"KeyType": "HASH"
								}
							],
							"Projection": {
								"ProjectionType": "ALL"
							}
						}
					]
				}
			}
		];

		tests.forEach((test) => {
			it(test.name, async () => {
				expect(await new dynamoose.Schema(test.input).getCreateTableAttributeParams({"options": {"throughput": "ON_DEMAND"}})).to.eql(test.output);
			});
		});
	});

	describe("attributes", () => {
		const tests = [
			{
				"name": "Should return correct result with one attribute",
				"input": {"id": String},
				"output": ["id"]
			},
			{
				"name": "Should return correct result with one attribute and object as value",
				"input": {"id": {"type": String}},
				"output": ["id"]
			},
			{
				"name": "Should return correct result with multiple attributes",
				"input": {"id": String, "age": Number},
				"output": ["id", "age"]
			},
			{
				"name": "Should return correct result with multiple attributes and object as values",
				"input": {"id": {"type": String}, "age": {"type": Number}},
				"output": ["id", "age"]
			},
			{
				"name": "Should return correct result with object type",
				"input": {"id": Number, "address": {"type": Object, "schema": {"street": String, "country": {"type": String, "required": true}}}},
				"output": ["id", "address", "address.street", "address.country"]
			},
			{
				"name": "Should return correct result with object type and no schema",
				"input": {"id": Number, "address": Object},
				"output": ["id", "address"]
			},
			{
				"name": "Should return correct result for multiple attribute types",
				"input": {"id": Number, "data": [String, Number]},
				"output": ["id", "data"]
			},
			{
				"name": "Should return correct result for multiple attribute types and one as array",
				"input": {"id": Number, "data": [{"type": Array, "schema": [Number]}, Number]},
				"output": ["id", "data", "data.0"]
			},
			{
				"name": "Should work for multiple nested types",
				"input": {"id": Number, "data": [{"type": Array, "schema": [String]}, {"type": Object, "schema": {"name": String}}]},
				"output": ["id", "data", "data.0", "data.name"]
			}
		];

		tests.forEach((test) => {
			it(test.name, () => {
				expect(new dynamoose.Schema(test.input).attributes()).to.eql(test.output);
			});
		});
	});

	describe("getSettingValue", () => {
		const tests = [
			{"name": "Should return correct value as array for settings", "settings": {"saveUnknown": ["name"]}, "input": "saveUnknown", "output": ["name"]},
			{"name": "Should return correct value as boolean for settings", "settings": {"saveUnknown": true}, "input": "saveUnknown", "output": true},
			{"name": "Should return undefined if key doesn't exist in settings", "settings": {"saveUnknown": true}, "input": "random", "output": undefined}
		];

		tests.forEach((test) => {
			it(test.name, () => {
				expect(new dynamoose.Schema({"id": String}, test.settings).getSettingValue(test.input)).to.eql(test.output);
			});
		});
	});

	describe("getAttributeTypeDetails", () => {
		it("Should throw for invalid attribute", () => {
			const func = () => new dynamoose.Schema({"id": String}).getAttributeTypeDetails("random");
			expect(func).to.throw(Error.UnknownAttribute);
			expect(func).to.throw("Invalid Attribute: random");
		});

		it("Should not throw for attribute with number in it (without . prefix)", () => {
			const func = () => new dynamoose.Schema({"id": String, "ran2dom": String}).getAttributeTypeDetails("ran2dom");
			expect(func).to.not.throw(Error.UnknownAttribute);
			expect(func).to.not.throw("Invalid Attribute: ran2dom");
		});

		it("Should have correct custom type for date", () => {
			const functions = new dynamoose.Schema({"id": Date}).getAttributeTypeDetails("id").customType.functions;
			expect(functions.toDynamo).to.exist;
			expect(functions.fromDynamo).to.exist;
			expect(functions.toDynamo(new Date(1582246653000))).to.eql(1582246653000);
			expect(functions.fromDynamo(1582246653000)).to.eql(new Date(1582246653000));
		});

		it("Should have correct custom type for date with type object and no settings", () => {
			const functions = new dynamoose.Schema({"id": {"type": {"value": Date}}}).getAttributeTypeDetails("id").customType.functions;
			expect(functions.toDynamo).to.exist;
			expect(functions.fromDynamo).to.exist;
			expect(functions.toDynamo(new Date(1582246653000))).to.eql(1582246653000);
			expect(functions.fromDynamo(1582246653000)).to.eql(new Date(1582246653000));
		});

		it("Should have correct custom type for date with custom storage settings as miliseconds", () => {
			const functions = new dynamoose.Schema({"id": {"type": {"value": Date, "settings": {"storage": "miliseconds"}}}}).getAttributeTypeDetails("id").customType.functions;
			expect(functions.toDynamo).to.exist;
			expect(functions.fromDynamo).to.exist;
			expect(functions.toDynamo(new Date(1582246653000))).to.eql(1582246653000);
			expect(functions.fromDynamo(1582246653000)).to.eql(new Date(1582246653000));
		});

		it("Should have correct custom type for date with custom storage settings as seconds", () => {
			const functions = new dynamoose.Schema({"id": {"type": {"value": Date, "settings": {"storage": "seconds"}}}}).getAttributeTypeDetails("id").customType.functions;
			expect(functions.toDynamo).to.exist;
			expect(functions.fromDynamo).to.exist;
			expect(functions.toDynamo(new Date(1582246653000))).to.eql(1582246653);
			expect(functions.fromDynamo(1582246653)).to.eql(new Date(1582246653000));
		});

		it("Should have correct result for multiple types", () => {
			const result = new dynamoose.Schema({"id": {"type": [String, Buffer]}}).getAttributeTypeDetails("id");
			expect(result.map((item) => ({"name": item.name, "dynamodbType": item.dynamodbType}))).to.eql([{"name": "String", "dynamodbType": "S"}, {"name": "Buffer", "dynamodbType": "B"}]);
		});
	});

	describe("getAttributeSettingValue", () => {
		const tests = [
			// Defaults
			{
				"name": "Should return undefined if no object as value for attribute",
				"input": ["default", "id"],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return undefined if no default for attribute",
				"input": ["default", "id"],
				"schema": {"id": {"type": String}},
				"output": undefined
			},
			{
				"name": "Should return undefined for attribute that doesn't exist",
				"input": ["default", "random"],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return default as string for attribute",
				"input": ["default", "id"],
				"schema": {"id": {"type": String, "default": "Hello World"}},
				"output": "Hello World"
			},
			{
				"name": "Should return default as string for attribute if default is a function",
				"input": ["default", "id"],
				"schema": {"id": {"type": String, "default": () => "Hello World"}},
				"output": "Hello World"
			},
			{
				"name": "Should return default as string for attribute if default is an async function",
				"input": ["default", "id"],
				"schema": {"id": {"type": String, "default": async () => "Hello World"}},
				"output": "Hello World"
			},
			{
				"name": "Should return default as string for attribute if default is a function that returns a promise",
				"input": ["default", "id"],
				"schema": {"id": {"type": String, "default": () => {
					return new Promise((resolve) => setTimeout(() => resolve("Hello World"), 10));
				}}},
				"output": "Hello World"
			},
			// Validator
			{
				"name": "Should return undefined if no object as value for attribute",
				"input": ["validate", "id", {"returnFunction": true}],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return undefined if no validator for attribute",
				"input": ["validate", "id", {"returnFunction": true}],
				"schema": {"id": {"type": String}},
				"output": undefined
			},
			{
				"name": "Should return undefined for attribute that doesn't exist",
				"input": ["validate", "random", {"returnFunction": true}],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return validator as string for attribute",
				"input": ["validate", "id", {"returnFunction": true}],
				"schema": {"id": {"type": String, "validate": "Hello World"}},
				"output": "Hello World"
			},
			{
				"name": "Should return validator as function for attribute if validator is a function",
				"input": ["validate", "id", {"returnFunction": true}],
				"schema": {"id": {"type": String, "validate": () => "Hello World"}},
				"output": () => "Hello World"
			},
			{
				"name": "Should return validator as function for attribute if validator is an async function",
				"input": ["validate", "id", {"returnFunction": true}],
				"schema": {"id": {"type": String, "validate": async () => "Hello World"}},
				"output": async () => "Hello World"
			},
			{
				"name": "Should return validator as function for attribute if validator is a function that returns a promise",
				"input": ["validate", "id", {"returnFunction": true}],
				"schema": {"id": {"type": String, "validate": () => new Promise((resolve) => setTimeout(() => resolve("Hello World"), 10))}},
				"output": () => new Promise((resolve) => setTimeout(() => resolve("Hello World"), 10))
			},
			// Required
			{
				"name": "Should return undefined if no object as value for attribute",
				"input": ["required", "id"],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return undefined if no required setting for attribute",
				"input": ["required", "id"],
				"schema": {"id": {"type": String}},
				"output": undefined
			},
			{
				"name": "Should return undefined for attribute that doesn't exist",
				"input": ["required", "random"],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return required as true for attribute being required",
				"input": ["required", "id"],
				"schema": {"id": {"type": String, "required": true}},
				"output": true
			},
			{
				"name": "Should return required as false for attribute being not required",
				"input": ["required", "id"],
				"schema": {"id": {"type": String, "required": false}},
				"output": false
			},
			// Enum
			{
				"name": "Should return undefined if no object as value for attribute",
				"input": ["enum", "id"],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return undefined if no enum setting for attribute",
				"input": ["enum", "id"],
				"schema": {"id": {"type": String}},
				"output": undefined
			},
			{
				"name": "Should return undefined for attribute that doesn't exist",
				"input": ["enum", "random"],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return enum array for attribute having enum",
				"input": ["enum", "id"],
				"schema": {"id": {"type": String, "enum": ["Tim", "Tom"]}},
				"output": ["Tim", "Tom"]
			},
			// forceDefault
			{
				"name": "Should return undefined if no object as value for attribute",
				"input": ["forceDefault", "id"],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return undefined if no forceDefault setting for attribute",
				"input": ["forceDefault", "id"],
				"schema": {"id": {"type": String}},
				"output": undefined
			},
			{
				"name": "Should return undefined for attribute that doesn't exist",
				"input": ["forceDefault", "random"],
				"schema": {"id": String},
				"output": undefined
			},
			{
				"name": "Should return forceDefault as true for attribute with forceDefault set to true",
				"input": ["forceDefault", "id"],
				"schema": {"id": {"type": String, "forceDefault": true}},
				"output": true
			},
			{
				"name": "Should return forceDefault as false for attribute with forceDefault set to false",
				"input": ["forceDefault", "id"],
				"schema": {"id": {"type": String, "forceDefault": false}},
				"output": false
			}
		];

		tests.forEach((test) => {
			it(test.name, async () => {
				const schema = new dynamoose.Schema(test.schema);
				const output = await schema.getAttributeSettingValue(...test.input);
				if (typeof output !== "function") {
					expect(output).to.eql(test.output);
				} else {
					expect(typeof output).to.eql(typeof test.output);
					expect(output.toString()).to.eql(test.output.toString());
					expect(await output()).to.eql(await test.output());
				}
			});
		});
	});

	describe("getIndexAttributes", () => {
		const tests = [
			{
				"name": "Should return an empty array if no indicies are defined",
				"schema": {"id": String},
				"output": []
			},
			{
				"name": "Should return an array containing definitions for an boolean defined index",
				"schema": {"id": {"type": String, "index": true}},
				"output": [{"attribute": "id", "index": true}]
			},
			{
				"name": "Should return an array containing definitions for an object defined index",
				"schema": {"id": {"type": String, "index": {"global": true, "name": "id-index"}}},
				"output": [{"attribute": "id", "index": {"global": true, "name": "id-index"}}]
			},
			{
				"name": "Should return an array containing definitions for an array defined index",
				"schema": {"id": {"type": String, "index": [{"global": true, "name": "id-index"}]}},
				"output": [{"attribute": "id", "index": {"global": true, "name": "id-index"}}]
			},
			{
				"name": "Should return an array containing multiple definitions for array defined indexes",
				"schema": {"id": {"type": String, "index": [{"global": true, "name": "id-index-1"}, {"global": false, "name": "id-index-2"}]}},
				"output": [{"attribute": "id", "index": {"global": true, "name": "id-index-1"}}, {"attribute": "id", "index": {"global": false, "name": "id-index-2"}}]
			},
			{
				"name": "Should aggregate an array containing multiple definitions for all defined indexes",
				"schema": {"id": {"type": String, "index": [{"global": true, "name": "id-index-1"}, {"global": false, "name": "id-index-2"}]}, "uid": {"type": String, "index": {"global": true, "name": "uid-index"}}, "uuid": {"type": String}},
				"output": [{"attribute": "id", "index": {"global": true, "name": "id-index-1"}}, {"attribute": "id", "index": {"global": false, "name": "id-index-2"}}, {"attribute": "uid", "index": {"global": true, "name": "uid-index"}}]
			},
			{
				"name": "Should work with multiple types for single attribute",
				"schema": {"id": String, "data": [String, Number]},
				"output": []
			}
		];

		tests.forEach((test) => {
			it(test.name, async () => {
				const schema = new dynamoose.Schema(test.schema);
				const output = await schema.getIndexAttributes();
				expect(output).to.eql(test.output);
			});
		});
	});

	describe("getTypePaths", () => {
		it("Should be a function", () => {
			expect(new dynamoose.Schema({"id": String}).getTypePaths).to.be.a("function");
		});

		const tests = [
			{"schema": {"id": String, "data": [String, Number]}, "input": {"id": "id1", "data": "hello world"}, "output": {"data": 0}},
			{"schema": {"id": String, "data": [String, Number]}, "input": {"id": "id1", "data": 10}, "output": {"data": 1}},
			{"schema": {"id": String, "data": [{"type": Object, "schema": {"item1": String}}, {"type": Object, "schema": {"item2": String}}]}, "input": {"id": "id1", "data": {"item1": "hello"}}, "output": {"data": 0}},
			{"schema": {"id": String, "data": [{"type": Object, "schema": {"item1": String}}, {"type": Object, "schema": {"item2": String}}]}, "input": {"id": "id1", "data": {"item2": "hello"}}, "output": {"data": 1}},
			{"schema": {"id": String, "data": [{"type": Object, "schema": {"item1": String}}, {"type": Object, "schema": {"item1": Number}}]}, "input": {"id": "id1", "data": {"item1": "hello"}}, "output": {"data": 0}},
			{"schema": {"id": String, "data": [{"type": Object, "schema": {"item1": String}}, {"type": Object, "schema": {"item1": Number}}]}, "input": {"id": "id1", "data": {"item1": 10}}, "output": {"data": 1}},
			{"schema": {"id": Number, "data": [{"type": Object, "schema": {"name": String, "id1": String}}, {"type": Object, "schema": {"name": Number, "id2": String}}]}, "input": {"id": 1, "data": {"name": 1, "id1": "1", "id2": "1"}}, "output": {"data": 1}},
			{"schema": {"id": Number, "data": [{"type": Object, "schema": {"name": String, "id1": Number}}, {"type": Object, "schema": {"name": Number, "id2": String}}]}, "input": {"id": 1, "data": {"name": 1, "id2": 2}}, "output": {"data": 1}},
			{"schema": {"id": Number, "data": String}, "input": {"id": 1, "data9": "Hello"}, "settings": {"includeAllProperties": true}, "output": {"id": {"index": 0, "entryCorrectness": [1], "matchCorrectness": 1}, "data9": {"index": 0, "entryCorrectness": [0.5], "matchCorrectness": 0.5}}},
			{"schema": {"id": Number, "data": {"type": Object, "schema": {"parameter": String}}}, "input": {"id": 1, "data": {"parameter": "hello"}}, "settings": {"includeAllProperties": true}, "output": {"id": {"index": 0, "entryCorrectness": [1], "matchCorrectness": 1}, "data": {"index": 0, "entryCorrectness": [1], "matchCorrectness": 1}, "data.parameter": {"entryCorrectness": [1], "index": 0, "matchCorrectness": 1}}},
			{"schema": {"id": Number, "data": {"type": Object, "schema": {"parameter": Number}}}, "input": {"id": 1, "data": {"parameter": "hello"}}, "settings": {"includeAllProperties": true}, "output": {"id": {"index": 0, "entryCorrectness": [1], "matchCorrectness": 1}, "data": {"index": 0, "entryCorrectness": [1], "matchCorrectness": 1}, "data.parameter": {"entryCorrectness": [0], "index": 0, "matchCorrectness": 0}}},
			// this function is ideally used to determine exact type of the object when there is a choice in schema definition around a property , so this function should return {} for simple strict schemas  
			// as demonstated in below two test cases , highlight simple strict schemas where this function just returns empty 
			{"schema": {"id": String, "data": Buffer}, "input": {"id": "id1", "data": Buffer.from("hello world")}, "output": {}},
			{"schema": {"id": String, "data": String}, "input": {"id": "id1", "data": "hello world"}, "output": {}},
		];

		tests.forEach((test) => {
			it(`Should return ${JSON.stringify(test.output)} for ${JSON.stringify(test.input)} with schema as ${JSON.stringify(test.schema)}`, () => {
				expect(new dynamoose.Schema(test.schema).getTypePaths(test.input, test.settings)).to.eql(test.output);
			});
		});
	});
});
