(function () {
  if (!Map.prototype.getOrInsertComputed) {
    Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value: function (key, callback) {
        if (this.has(key)) return this.get(key);
        var value = callback(key);
        this.set(key, value);
        return value;
      },
    });
  }
  if (!Map.prototype.getOrInsert) {
    Object.defineProperty(Map.prototype, 'getOrInsert', {
      configurable: true,
      writable: true,
      value: function (key, value) {
        if (this.has(key)) return this.get(key);
        this.set(key, value);
        return value;
      },
    });
  }
  if (!Promise.withResolvers) {
    Promise.withResolvers = function () {
      var resolve, reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }
  if (!Uint8Array.fromBase64) {
    Uint8Array.fromBase64 = function (value) {
      var normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
      while (normalized.length % 4) normalized += '=';
      var binary = atob(normalized);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    };
  }
  if (!Uint8Array.prototype.toBase64) {
    Object.defineProperty(Uint8Array.prototype, 'toBase64', {
      configurable: true,
      writable: true,
      value: function () {
        var binary = '';
        for (var i = 0; i < this.length; i += 0x8000) binary += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
        return btoa(binary);
      },
    });
  }
  if (!globalThis.structuredClone) globalThis.structuredClone = function (value) { return JSON.parse(JSON.stringify(value)); };
})();
