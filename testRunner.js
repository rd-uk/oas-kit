'use strict';

var fs = require('fs');
var path = require('path');
var rr = require('recursive-readdir');
var yaml = require('js-yaml');

var common = require('./common.js');
var swagger2openapi = require('./index.js');
var validator = require('./validate.js');

var argv = require('yargs')
	.usage('testRunner [options] [{path-to-specs}...]')
	.string('encoding')
	.alias('e','encoding')
	.default('encoding','utf8')
	.describe('encoding','encoding for input/output files')
	.string('fail')
	.describe('fail','path to specs expected to fail')
	.alias('f','fail')
	.boolean('stop')
	.alias('s','stop')
	.describe('stop','stop on first error')
	.boolean('quiet')
	.alias('q','quiet')
	.describe('quiet','do not show test passes on console, for CI')
	.boolean('resolve')
	.alias('r','resolve')
	.describe('resolve','resolve external references')
	.count('verbose')
	.alias('v','verbose')
	.describe('verbose','increase verbosity')
	.help('h')
    .alias('h', 'help')
	.strict()
	.version(function() {
		return require('../package.json').version;
	})
	.argv;

var red = process.env.NODE_DISABLE_COLORS ? '' : '\x1b[31m';
var green = process.env.NODE_DISABLE_COLORS ? '' : '\x1b[32m';
var normal = process.env.NODE_DISABLE_COLORS ? '' : '\x1b[0m';

var pass = 0;
var fail = 0;
var failures = [];
var warnings = [];

var genStack = [];
var genStackCount = 0;

var options = argv;
options.patch = true;

function handleResult(err, options) {
	var result = false;
	if (err) {
		console.log(red+'Converter: '+err.message);
		options = err.options||{file:'unknown',src:{info:{version:'',title:''}}};
	}
	else {
		result = options.openapi;
	}
	var resultStr = JSON.stringify(result);

	if (typeof result !== 'boolean') try {
		var src = options.original;
		resultStr = yaml.safeDump(result); // should be representable safely in yaml
		resultStr.should.not.be.exactly('{}');

		result = validator.validateSync(result,options);

		if (!argv.quiet) {
			console.log(normal+options.file);
			var colour = ((options.expectFailure ? !result : result) ? green : red);
			console.log(colour+'  %s %s',src.info.title,src.info.version);
			console.log('  %s',src.swagger ? (src.host ? src.host : 'relative') : (src.servers && src.servers.length ? src.servers[0].url : 'relative'));
		}
	}
	catch (ex) {
		console.log(normal+options.file);
		console.log(red+options.context.pop()+'\n'+ex.message);
		result = !!options.expectFailure;
	}
	if (result) {
		pass++;
	}
	else {
		fail++;
		if (options.file != 'unknown') failures.push(options.file);
		if (argv.stop) process.exit(1);
	}
	if (!genStackNext()) process.exit(0);
}

function genStackNext() {
	if (!genStack.length) return false;
	var gen = genStack.pop();
	gen.next();
	return true;
}

function* wrapConvert(src,options,processor,callback){
	try {
		swagger2openapi.convertObj(src, common.clone(options), processor);
	}
	catch (ex) {
		console.log(red+'Converter threw an error: '+ex.message);
		warnings.push('Converter failed '+options.source);
		result = true;
	}
}

function check(file,force,expectFailure) {
	var result = false;
	options.context = [];
	options.expectFailure = expectFailure;
	options.file = file;
	var components = file.split(path.sep);
	var name = components[components.length-1];

	if ((name.indexOf('.yaml')>=0) || (name.indexOf('.json')>=0) || force) {

		var srcStr = fs.readFileSync(path.resolve(file),options.encoding);
		var src;
		try {
			src = JSON.parse(srcStr);
		}
		catch (ex) {
			try {
				src = yaml.safeLoad(srcStr);
			}
			catch (ex) {
				var warning = 'Could not parse file '+file;
				console.log(red+warning);
				warnings.push(warning);
			}
		}

		if (!src || ((!src.swagger && !src.openapi))) return true;

		options.original = src;
		options.source = file;

		genStack.push(wrapConvert(src, common.clone(options), handleResult));
		genStackCount++;
	}
	else {
		result = true;
	}
	if (genStackCount === 1) genStackNext(); // start the testing process
	return result;
}

function processPathSpec(pathspec,expectFailure) {
	pathspec = path.resolve(pathspec);
	var stats = fs.statSync(pathspec);
	if (stats.isFile()) {
		check(pathspec,true,expectFailure)
	}
	else {
		rr(pathspec, function (err, files) {
			for (var i in files) {
				check(files[i],false,expectFailure);
			}
		});
	}
}

process.exitCode = 1;
console.log('Gathering...');
if ((!argv._.length) && (!argv.fail)) {
	argv._.push('../openapi-directory/APIs/');
}
for (var pathspec of argv._) {
	processPathSpec(pathspec,false);
}
if (argv.fail) {
	if (!Array.isArray(argv.fail)) argv.fail = [argv.fail];
	for (var pathspec of argv.fail) {
		processPathSpec(pathspec,true);
	}
}

process.on('exit', function(code) {
	if (warnings.length) {
		warnings.sort();
		console.log(normal+'\nWarnings:'+red);
		for (var w in warnings) {
			console.log(warnings[w]);
		}
	}
	if (failures.length) {
		failures.sort();
		console.log(normal+'\nFailures:'+red);
		for (var f in failures) {
			console.log(failures[f]);
		}
	}
	console.log(normal);
	console.log('Tests: %s passing, %s failing, %s warnings', pass, fail, warnings.length);
	process.exitCode = ((fail === 0) && (pass > 0)) ? 0 : 1;
});
