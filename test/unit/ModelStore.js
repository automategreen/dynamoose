const chai = require("chai");
const {expect} = chai;
const ModelStore = require("../../dist/ModelStore");

describe("ModelStore", () => {
	it("Should be a function", () => {
		expect(ModelStore).to.be.a("function");
	});

	it("Should throw an error if nothing passed in", () => {
		expect(() => ModelStore()).to.throw("You must pass in a Model or model name as a string.");
	});
});
