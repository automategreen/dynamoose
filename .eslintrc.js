module.exports = {
	"parser": "@typescript-eslint/parser",
	"parserOptions": {
		"sourceType": "module",
	},
	"env": {
		"commonjs": true,
		"es6": true,
		"node": true,
	},
	"plugins": ["@typescript-eslint/eslint-plugin"],
	"extends": [
		"eslint:recommended",
		"plugin:@typescript-eslint/eslint-recommended",
		"plugin:@typescript-eslint/recommended",
	],
	"rules": {
		"@typescript-eslint/no-explicit-any": "off",
		"@typescript-eslint/no-unused-vars": "off",
		"@typescript-eslint/camelcase": "off",
		"@typescript-eslint/no-this-alias": "off",
		"@typescript-eslint/no-var-requires": "off",
		"@typescript-eslint/comma-spacing": "error",
		"object-curly-spacing": ["error", "always"],
		"space-before-function-paren": ["error", "always"],
		"space-before-blocks": ["error", "always"],
		"no-multi-spaces": "error",
		"space-in-parens": "error",
		"indent": ["error", "tab"],
		"linebreak-style": ["error", "unix"],
		"quotes": ["error", "double"],
		"semi": ["error", "always"],
		"quote-props": ["error", "always"],
	},
	"globals": {
		"Atomics": "readonly",
		"SharedArrayBuffer": "readonly",
	},
};
