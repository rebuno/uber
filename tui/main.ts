#!/usr/bin/env node
import { argv } from "node:process";

import { App } from "./app.js";
import { loadClientExtensions } from "./extensions.js";
import pkg from "./package.json" with { type: "json" };
import { setupUi } from "./ui.js";

if (argv[2] === "--version" || argv[2] === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

const extensions = await loadClientExtensions();
setupUi(extensions.settings.getTheme());
await new App(argv[2], extensions).run();
process.exit(0);
