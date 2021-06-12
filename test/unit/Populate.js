const chai = require("chai");
const {expect} = chai;
const Populate = require("../../dist/Populate");
const dynamoose = require("../../dist");
const aws = require("../../dist/aws");
const util = require("util");
const utils = require("../../dist/utils");

describe("Populate", () => {
	it("Should be an object", () => {
		expect(Populate).to.be.an("object");
	});

	let User;
	beforeEach(() => {
		User = dynamoose.model("User", {"id": Number, "name": String, "parent": dynamoose.THIS});
		new dynamoose.Table("User", [User], {"create": false, "waitForActive": false});
	});
	afterEach(() => {
		User = null;
	});
	const responseTypes = [
		{"name": "Promise", "func": (input) => input.populate},
		{"name": "Callback", "func": (input) => util.promisify(input.populate)}
	];
	responseTypes.forEach((responseType) => {
		describe(responseType.name, () => {
			const populateTypes = [
				{
					"name": "PopulateItem",
					"func": Populate.PopulateItem,
					"tests": [
						{"input": {"id": 2, "name": "Tim"}, "output": {"id": 2, "name": "Tim"}, "items": [{"id": 1, "name": "Bob"}]},
						{"input": {"id": 2, "name": "Tim", "parent": 1}, "output": {"id": 2, "name": "Tim", "parent": {"id": 1, "name": "Bob"}}, "items": [{"id": 1, "name": "Bob"}]},
						{"input": {"id": 2, "name": "Tim", "parent": 1}, "output": {"id": 2, "name": "Tim", "parent": {"id": 1, "name": "Bob", "parent": {"id": 3, "name": "Evan"}}}, "items": [{"id": 1, "name": "Bob", "parent": 3}, {"id": 3, "name": "Evan"}]},
						{"input": {"id": 2, "name": "Tim", "parent": 1}, "output": {"id": 2, "name": "Tim", "parent": {"id": 1, "name": "Bob", "parent": 3}}, "items": [{"id": 1, "name": "Bob", "parent": 3}, {"id": 3, "name": "Evan"}], "settings": {"properties": "*"}},
						{"input": {"id": 2, "name": "Tim", "parent": 1}, "output": {"id": 2, "name": "Tim", "parent": {"id": 1, "name": "Bob", "parent": 3}}, "items": [{"id": 1, "name": "Bob", "parent": 3}, {"id": 3, "name": "Evan"}], "settings": {"properties": ["*"]}},
						{"schema": {"id": Number, "name": String, "parent": [dynamoose.THIS, String]}, "input": {"id": 2, "name": "Tim", "parent": 1}, "output": {"id": 2, "name": "Tim", "parent": {"id": 1, "name": "Bob", "parent": 3}}, "items": [{"id": 1, "name": "Bob", "parent": 3}, {"id": 3, "name": "Evan"}], "settings": {"properties": ["*"]}}
					]
				},
				{
					"name": "PopulateItems",
					"func": Populate.PopulateItems,
					"tests": [
						{"input": [{"id": 2, "name": "Tim"}], "output": [{"id": 2, "name": "Tim"}], "items": [{"id": 1, "name": "Bob"}]},
						{"input": [{"id": 2, "name": "Tim", "parent": 1}], "output": [{"id": 2, "name": "Tim", "parent": {"id": 1, "name": "Bob"}}], "items": [{"id": 1, "name": "Bob"}]},
						{"input": [{"id": 2, "name": "Tim", "parent": 1}], "output": [{"id": 2, "name": "Tim", "parent": {"id": 1, "name": "Bob", "parent": {"id": 3, "name": "Evan"}}}], "items": [{"id": 1, "name": "Bob", "parent": 3}, {"id": 3, "name": "Evan"}]},
						{"input": [{"id": 2, "name": "Tim", "parent": 1}], "output": [{"id": 2, "name": "Tim", "parent": {"id": 1, "name": "Bob", "parent": 3}}], "items": [{"id": 1, "name": "Bob", "parent": 3}, {"id": 3, "name": "Evan"}], "settings": {"properties": "*"}},
						{"input": [{"id": 2, "name": "Tim", "parent": 1}], "output": [{"id": 2, "name": "Tim", "parent": {"id": 1, "name": "Bob", "parent": 3}}], "items": [{"id": 1, "name": "Bob", "parent": 3}, {"id": 3, "name": "Evan"}], "settings": {"properties": ["*"]}}
					]
				}
			];
			populateTypes.forEach((populateType) => {
				describe(populateType.name, () => {
					let promiseFunction;
					beforeEach(() => {
						dynamoose.aws.ddb.set({
							"getItem": (param) => {
								return {"promise": () => promiseFunction(param)};
							}
						});
					});
					afterEach(() => {
						promiseFunction = null;
						dynamoose.aws.ddb.revert();
					});

					it("Should be a function", () => {
						expect(populateType.func).to.be.a("function");
					});

					populateType.tests.forEach((test) => {
						it(`Should return ${JSON.stringify(test.output)} for ${JSON.stringify(test.input)}`, async () => {
							if (test.schema) {
								User = dynamoose.model("User", test.schema);
								new dynamoose.Table("User", [User], {"create": false, "waitForActive": false});
							}

							promiseFunction = (param) => ({"Item": aws.converter().marshall(test.items.find((doc) => doc.id === parseInt(param.Key.id.N)))});

							const input = Array.isArray(test.input) ? Object.assign(test.input.map((item) => new User(item)), {"populate": Populate.PopulateItems, "toJSON": utils.dynamoose.itemToJSON}) : new User(test.input);
							const res = await responseType.func(input).bind(input)(test.settings || {});
							expect(res.toJSON()).to.eql(test.output);
						});
					});

					it("Should throw error if error from AWS", () => {
						promiseFunction = () => {
							throw "ERROR";
						};

						const obj = new User({"id": 2, "name": "Tim", "parent": 1});
						const input = populateType.name === "PopulateItems" ? Object.assign([obj], {"populate": Populate.PopulateItems}) : obj;
						const res = responseType.func(input).bind(input)();
						return expect(res).to.be.rejectedWith("ERROR");
					});
				});
			});
		});
	});
});
