const { join } = require("path");

/**
 * Where Puppeteer keeps its Chrome download. On Render, only the project directory is carried from
 * the build to the running service, so Chrome must live inside it (the default, ~/.cache/puppeteer,
 * is left behind). Elsewhere the default is kept, so local installs keep using the existing Chrome.
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  cacheDirectory: process.env.RENDER ? join(__dirname, ".cache", "puppeteer") : undefined,
};
