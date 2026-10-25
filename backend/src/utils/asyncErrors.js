import Layer from "express/lib/router/layer.js";

// Express 4 ignores promise rejections from async route handlers, which
// leaves the request hanging (and, on modern Node, can crash the process).
// Route rejections to the normal error handler instead.
const originalHandleRequest = Layer.prototype.handle_request;

Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) {
    return next();
  }

  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === "function") {
      result.catch(next);
    }
  } catch (error) {
    next(error);
  }
};

export { originalHandleRequest };
