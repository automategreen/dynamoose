This release ________

Please comment or [contact me](https://charlie.fish/contact) if you have any questions about this release.

### 🚨 Breaking Changes 🚨

- Upgraded to AWS-SDK v3
	- This leads to a MASSIVE reduction in the package size of Dynamoose
	- Only users using the `dynamoose.aws` object will be impacted (if you are only using `dynamoose.aws.ddb.local`, there will be no breaking changes)
	- In depth changelog:
		- `dynamoose.aws.sdk` has been removed
		- `dynamoose.aws.ddb` now references a `@aws-sdk/client-dynamodb` `DynamoDB` instance instead of the previous `AWS.DynamoDB` instance
			- Please refer to the AWS-SDK v3 changelogs for more information about what this means for you
		- `dynamoose.aws.converter` now uses the methods from `@aws-sdk/util-dynamodb`
			- `input` has changed to `convertToAttr`
			- `output` has changed to `convertToNative`
			- For more information please refer to the AWS-SDK v3 changelogs
- Added `dynamoose.Table` class. `dynamoose.model` now represents an entity or type of data (ex. User, Movie, Order), and `dynamoose.Table` represents a single DynamoDB table. The example below show how to convert your code to this new syntax.
```
// If you have the following code in v2:

const User = dynamoose.model("User", {"id": String});

// It will be converted to this in v3:

const User = dynamoose.model("User", {"id": String});
const DBTable = new dynamoose.Table("DBTable", [User]);
```
- Renamed `Document` to `Item`
	- The largest user facing API change is changing `{"return": "document"}` to `{"return": "item"}` and `{"return": "documents"}` to `{"return": "items"}`
- `dynamoose.logger` is now an async function instead of an object. For example, `dynamoose.logger.status()` is now `(await dynamoose.logger()).status()`
	- You must also now install the `dynamoose-logger` package in order to use `dynamoose.logger()`, otherwise an error will be thrown.
- Node.js >=v10 now required

### Major New Features

### General

- Added `table.create()` method to create a table manually
- Added `table.name` property to be able to access table name
- Added `model.name` property to be able to access model name

### Bug Fixes

### Documentation

### Other

- Source map files are no longer included in the package
	- You can generate source map files by cloning the reposistory, running `npm install`, then running `npm run build:sourcemap`. The generated source map files will be located in the `dist` folder.
- Made a lot of internal properties private
	- This is not considered a breaking change since only documented properties, classes, methods, and functions are included in breaking changes. You should only be using documented properties, classes, methods, and functions in Dynamoose. Anything not documented is subject to change at anytime. Read more at [this FAQ item](https://dynamoosejs.com/other/FAQ#can-i-use-an-undocumented-property-class-method-or-function-in-dynamoose).
- Moved `source-map-support` package into `devDependencies`
