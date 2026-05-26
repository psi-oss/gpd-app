// TC39 "upsert" proposal polyfills required by pdfjs-dist >= 5.7.
//
// pdfjs's worker message dispatcher calls `this.#methodPromises.getOrInsertComputed(...)`
// inside `PDFDocumentProxy.getPage()`. That method landed in WebKit 18.4
// (Safari 18.4, April 2025); the Tauri WKWebView on macOS still reports
// AppleWebKit/605.1.15 and doesn't expose it, so every `getPage()` throws
// `TypeError: this.#methodPromises.getOrInsertComputed is not a function`
// and the page canvas stays blank.
//
// Import this module BEFORE any `pdfjs-dist` import — ES modules hoist
// imports, so the only reliable way to run code before pdfjs's module
// initializer is to put it in a separate file and rely on import order
// within the importer.
//
// Spec: https://tc39.es/proposal-upsert/

if (typeof (Map.prototype as { getOrInsertComputed?: unknown }).getOrInsertComputed !== "function") {
  Object.defineProperty(Map.prototype, "getOrInsertComputed", {
    value: function <K, V>(this: Map<K, V>, key: K, callbackfn: (key: K) => V): V {
      if (this.has(key)) return this.get(key) as V
      const v = callbackfn(key)
      this.set(key, v)
      return v
    },
    writable: true,
    configurable: true,
  })
}

if (typeof (Map.prototype as { getOrInsert?: unknown }).getOrInsert !== "function") {
  Object.defineProperty(Map.prototype, "getOrInsert", {
    value: function <K, V>(this: Map<K, V>, key: K, value: V): V {
      if (this.has(key)) return this.get(key) as V
      this.set(key, value)
      return value
    },
    writable: true,
    configurable: true,
  })
}

if (typeof (WeakMap.prototype as { getOrInsertComputed?: unknown }).getOrInsertComputed !== "function") {
  Object.defineProperty(WeakMap.prototype, "getOrInsertComputed", {
    value: function <K extends object, V>(
      this: WeakMap<K, V>,
      key: K,
      callbackfn: (key: K) => V,
    ): V {
      if (this.has(key)) return this.get(key) as V
      const v = callbackfn(key)
      this.set(key, v)
      return v
    },
    writable: true,
    configurable: true,
  })
}
