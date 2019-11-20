#!/usr/bin/env node


const execa = require("execa");
const path = require("path");
execa.sync('node', [path.join(__dirname, "..", "dist", "index.js")], {stdio: 'inherit'});

