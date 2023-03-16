(function () {
    'use strict';

    /**
     * Exposes worker functions.
     *
     * @param functions - Map of name to function
     * @param readyPromise - A promise that must be resolved before any worker function calls
     */
    function expose(functions, readyPromise) {
        self.onmessage = async (msg) => {
            await readyPromise;
            const { name, args, transferableIndices } = msg.data;
            const transferables = [];
            let data;
            try {
                const workerFunction = functions[name];
                if (typeof workerFunction !== 'function') {
                    console.error(`${name} is not an exposed worker function`);
                    self.close();
                    return; // close doesn't immediately kill the worker
                }
                const result = await workerFunction(...args);
                args.forEach((arg, i) => transferableIndices.includes(i) && transferables.push(arg));
                data = { type: 'success', result, transferables };
            }
            catch (error) {
                const { message, name } = error;
                data = {
                    type: 'error',
                    error: {
                        message,
                        name
                    }
                };
            }
            self.postMessage(data, transferables);
        };
    }
    /**
     * Loads wasm generated by emscripten.
     *
     * @param script - The name of js wrapper.
     * @param options - The URL prefix of files if use CDN and function to execute before promise resolved.
     * @returns A promise that is resolved when wasm is loaded.
     */
    function loadWasm(script, options) {
        options = options || {};
        const { url, init } = options;
        return new Promise(resolve => {
            self.Module = {
                onRuntimeInitialized() {
                    init && init();
                    resolve(null);
                },
                locateFile(path, prefix) {
                    return (url || prefix) + path;
                }
            };
            importScripts((url || '') + script);
        });
    }

    const instanceOfAny = (object, constructors) => constructors.some((c) => object instanceof c);

    let idbProxyableTypes;
    let cursorAdvanceMethods;
    // This is a function to prevent it throwing up in node environments.
    function getIdbProxyableTypes() {
        return (idbProxyableTypes ||
            (idbProxyableTypes = [
                IDBDatabase,
                IDBObjectStore,
                IDBIndex,
                IDBCursor,
                IDBTransaction,
            ]));
    }
    // This is a function to prevent it throwing up in node environments.
    function getCursorAdvanceMethods() {
        return (cursorAdvanceMethods ||
            (cursorAdvanceMethods = [
                IDBCursor.prototype.advance,
                IDBCursor.prototype.continue,
                IDBCursor.prototype.continuePrimaryKey,
            ]));
    }
    const cursorRequestMap = new WeakMap();
    const transactionDoneMap = new WeakMap();
    const transactionStoreNamesMap = new WeakMap();
    const transformCache = new WeakMap();
    const reverseTransformCache = new WeakMap();
    function promisifyRequest(request) {
        const promise = new Promise((resolve, reject) => {
            const unlisten = () => {
                request.removeEventListener('success', success);
                request.removeEventListener('error', error);
            };
            const success = () => {
                resolve(wrap(request.result));
                unlisten();
            };
            const error = () => {
                reject(request.error);
                unlisten();
            };
            request.addEventListener('success', success);
            request.addEventListener('error', error);
        });
        promise
            .then((value) => {
            // Since cursoring reuses the IDBRequest (*sigh*), we cache it for later retrieval
            // (see wrapFunction).
            if (value instanceof IDBCursor) {
                cursorRequestMap.set(value, request);
            }
            // Catching to avoid "Uncaught Promise exceptions"
        })
            .catch(() => { });
        // This mapping exists in reverseTransformCache but doesn't doesn't exist in transformCache. This
        // is because we create many promises from a single IDBRequest.
        reverseTransformCache.set(promise, request);
        return promise;
    }
    function cacheDonePromiseForTransaction(tx) {
        // Early bail if we've already created a done promise for this transaction.
        if (transactionDoneMap.has(tx))
            return;
        const done = new Promise((resolve, reject) => {
            const unlisten = () => {
                tx.removeEventListener('complete', complete);
                tx.removeEventListener('error', error);
                tx.removeEventListener('abort', error);
            };
            const complete = () => {
                resolve();
                unlisten();
            };
            const error = () => {
                reject(tx.error || new DOMException('AbortError', 'AbortError'));
                unlisten();
            };
            tx.addEventListener('complete', complete);
            tx.addEventListener('error', error);
            tx.addEventListener('abort', error);
        });
        // Cache it for later retrieval.
        transactionDoneMap.set(tx, done);
    }
    let idbProxyTraps = {
        get(target, prop, receiver) {
            if (target instanceof IDBTransaction) {
                // Special handling for transaction.done.
                if (prop === 'done')
                    return transactionDoneMap.get(target);
                // Polyfill for objectStoreNames because of Edge.
                if (prop === 'objectStoreNames') {
                    return target.objectStoreNames || transactionStoreNamesMap.get(target);
                }
                // Make tx.store return the only store in the transaction, or undefined if there are many.
                if (prop === 'store') {
                    return receiver.objectStoreNames[1]
                        ? undefined
                        : receiver.objectStore(receiver.objectStoreNames[0]);
                }
            }
            // Else transform whatever we get back.
            return wrap(target[prop]);
        },
        set(target, prop, value) {
            target[prop] = value;
            return true;
        },
        has(target, prop) {
            if (target instanceof IDBTransaction &&
                (prop === 'done' || prop === 'store')) {
                return true;
            }
            return prop in target;
        },
    };
    function replaceTraps(callback) {
        idbProxyTraps = callback(idbProxyTraps);
    }
    function wrapFunction(func) {
        // Due to expected object equality (which is enforced by the caching in `wrap`), we
        // only create one new func per func.
        // Edge doesn't support objectStoreNames (booo), so we polyfill it here.
        if (func === IDBDatabase.prototype.transaction &&
            !('objectStoreNames' in IDBTransaction.prototype)) {
            return function (storeNames, ...args) {
                const tx = func.call(unwrap(this), storeNames, ...args);
                transactionStoreNamesMap.set(tx, storeNames.sort ? storeNames.sort() : [storeNames]);
                return wrap(tx);
            };
        }
        // Cursor methods are special, as the behaviour is a little more different to standard IDB. In
        // IDB, you advance the cursor and wait for a new 'success' on the IDBRequest that gave you the
        // cursor. It's kinda like a promise that can resolve with many values. That doesn't make sense
        // with real promises, so each advance methods returns a new promise for the cursor object, or
        // undefined if the end of the cursor has been reached.
        if (getCursorAdvanceMethods().includes(func)) {
            return function (...args) {
                // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
                // the original object.
                func.apply(unwrap(this), args);
                return wrap(cursorRequestMap.get(this));
            };
        }
        return function (...args) {
            // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION, so we use
            // the original object.
            return wrap(func.apply(unwrap(this), args));
        };
    }
    function transformCachableValue(value) {
        if (typeof value === 'function')
            return wrapFunction(value);
        // This doesn't return, it just creates a 'done' promise for the transaction,
        // which is later returned for transaction.done (see idbObjectHandler).
        if (value instanceof IDBTransaction)
            cacheDonePromiseForTransaction(value);
        if (instanceOfAny(value, getIdbProxyableTypes()))
            return new Proxy(value, idbProxyTraps);
        // Return the same value back if we're not going to transform it.
        return value;
    }
    function wrap(value) {
        // We sometimes generate multiple promises from a single IDBRequest (eg when cursoring), because
        // IDB is weird and a single IDBRequest can yield many responses, so these can't be cached.
        if (value instanceof IDBRequest)
            return promisifyRequest(value);
        // If we've already transformed this value before, reuse the transformed value.
        // This is faster, but it also provides object equality.
        if (transformCache.has(value))
            return transformCache.get(value);
        const newValue = transformCachableValue(value);
        // Not all types are transformed.
        // These may be primitive types, so they can't be WeakMap keys.
        if (newValue !== value) {
            transformCache.set(value, newValue);
            reverseTransformCache.set(newValue, value);
        }
        return newValue;
    }
    const unwrap = (value) => reverseTransformCache.get(value);

    /**
     * Open a database.
     *
     * @param name Name of the database.
     * @param version Schema version.
     * @param callbacks Additional callbacks.
     */
    function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
        const request = indexedDB.open(name, version);
        const openPromise = wrap(request);
        if (upgrade) {
            request.addEventListener('upgradeneeded', (event) => {
                upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
            });
        }
        if (blocked) {
            request.addEventListener('blocked', (event) => blocked(
            // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
            event.oldVersion, event.newVersion, event));
        }
        openPromise
            .then((db) => {
            if (terminated)
                db.addEventListener('close', () => terminated());
            if (blocking) {
                db.addEventListener('versionchange', (event) => blocking(event.oldVersion, event.newVersion, event));
            }
        })
            .catch(() => { });
        return openPromise;
    }

    const readMethods = ['get', 'getKey', 'getAll', 'getAllKeys', 'count'];
    const writeMethods = ['put', 'add', 'delete', 'clear'];
    const cachedMethods = new Map();
    function getMethod(target, prop) {
        if (!(target instanceof IDBDatabase &&
            !(prop in target) &&
            typeof prop === 'string')) {
            return;
        }
        if (cachedMethods.get(prop))
            return cachedMethods.get(prop);
        const targetFuncName = prop.replace(/FromIndex$/, '');
        const useIndex = prop !== targetFuncName;
        const isWrite = writeMethods.includes(targetFuncName);
        if (
        // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
        !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) ||
            !(isWrite || readMethods.includes(targetFuncName))) {
            return;
        }
        const method = async function (storeName, ...args) {
            // isWrite ? 'readwrite' : undefined gzipps better, but fails in Edge :(
            const tx = this.transaction(storeName, isWrite ? 'readwrite' : 'readonly');
            let target = tx.store;
            if (useIndex)
                target = target.index(args.shift());
            // Must reject if op rejects.
            // If it's a write operation, must reject if tx.done rejects.
            // Must reject with op rejection first.
            // Must resolve with op value.
            // Must handle both promises (no unhandled rejections)
            return (await Promise.all([
                target[targetFuncName](...args),
                isWrite && tx.done,
            ]))[0];
        };
        cachedMethods.set(prop, method);
        return method;
    }
    replaceTraps((oldTraps) => ({
        ...oldTraps,
        get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
        has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop),
    }));

    var luna_pinyin$2 = {
    };
    var stroke$3 = {
    };
    var tiger$2 = {
    };
    var tiger_guihu$2 = {
    	dict: "tiger_guihu.bootstrap"
    };
    var zrm_pinyin$2 = {
    };
    var kongmingma$2 = {
    };
    var tiger_core2022$2 = {
    };
    var PY_c$2 = {
    };
    var emoji$2 = {
    };
    var html_chars$2 = {
    };
    var latin_international$2 = {
    };
    var ipa_yunlong$2 = {
    };
    var short_punct$2 = {
    };
    var named_ipa_diacritics$2 = {
    };
    var chaizi$2 = {
    };
    var schemaFiles = {
    	luna_pinyin: luna_pinyin$2,
    	stroke: stroke$3,
    	tiger: tiger$2,
    	tiger_guihu: tiger_guihu$2,
    	zrm_pinyin: zrm_pinyin$2,
    	kongmingma: kongmingma$2,
    	tiger_core2022: tiger_core2022$2,
    	PY_c: PY_c$2,
    	emoji: emoji$2,
    	html_chars: html_chars$2,
    	latin_international: latin_international$2,
    	ipa_yunlong: ipa_yunlong$2,
    	short_punct: short_punct$2,
    	named_ipa_diacritics: named_ipa_diacritics$2,
    	chaizi: chaizi$2
    };

    var luna_pinyin$1 = "luna-pinyin";
    var stroke$2 = "stroke";
    var tiger$1 = "bczhc/rime-demo";
    var tiger_guihu$1 = "bczhc/rime-demo";
    var zrm_pinyin$1 = "bczhc/rime-demo";
    var kongmingma$1 = "bczhc/rime-demo";
    var tiger_core2022$1 = "bczhc/rime-demo";
    var PY_c$1 = "bczhc/rime-demo";
    var emoji$1 = "bczhc/rime-demo";
    var html_chars$1 = "bczhc/rime-demo";
    var latin_international$1 = "bczhc/rime-demo";
    var ipa_yunlong$1 = "bczhc/rime-demo";
    var short_punct$1 = "bczhc/rime-demo";
    var named_ipa_diacritics$1 = "bczhc/rime-demo";
    var chaizi$1 = "bczhc/rime-demo";
    var schemaTarget = {
    	luna_pinyin: luna_pinyin$1,
    	stroke: stroke$2,
    	tiger: tiger$1,
    	tiger_guihu: tiger_guihu$1,
    	zrm_pinyin: zrm_pinyin$1,
    	kongmingma: kongmingma$1,
    	tiger_core2022: tiger_core2022$1,
    	PY_c: PY_c$1,
    	emoji: emoji$1,
    	html_chars: html_chars$1,
    	latin_international: latin_international$1,
    	ipa_yunlong: ipa_yunlong$1,
    	short_punct: short_punct$1,
    	named_ipa_diacritics: named_ipa_diacritics$1,
    	chaizi: chaizi$1
    };

    var luna_pinyin = [
    	"stroke"
    ];
    var stroke$1 = [
    	"luna_pinyin"
    ];
    var tiger = [
    	"tiger_core2022",
    	"PY_c",
    	"emoji",
    	"html_chars",
    	"latin_international",
    	"ipa_yunlong",
    	"short_punct",
    	"named_ipa_diacritics"
    ];
    var tiger_guihu = [
    	"tiger_core2022",
    	"PY_c",
    	"emoji",
    	"html_chars",
    	"latin_international",
    	"ipa_yunlong",
    	"short_punct",
    	"named_ipa_diacritics"
    ];
    var zrm_pinyin = [
    	"chaizi"
    ];
    var kongmingma = [
    ];
    var tiger_core2022 = [
    ];
    var PY_c = [
    	"stroke"
    ];
    var emoji = [
    ];
    var html_chars = [
    ];
    var latin_international = [
    ];
    var ipa_yunlong = [
    	"named_ipa_diacritics"
    ];
    var short_punct = [
    ];
    var named_ipa_diacritics = [
    ];
    var chaizi = [
    ];
    var dependencyMap = {
    	luna_pinyin: luna_pinyin,
    	stroke: stroke$1,
    	tiger: tiger,
    	tiger_guihu: tiger_guihu,
    	zrm_pinyin: zrm_pinyin,
    	kongmingma: kongmingma,
    	tiger_core2022: tiger_core2022,
    	PY_c: PY_c,
    	emoji: emoji,
    	html_chars: html_chars,
    	latin_international: latin_international,
    	ipa_yunlong: ipa_yunlong,
    	short_punct: short_punct,
    	named_ipa_diacritics: named_ipa_diacritics,
    	chaizi: chaizi
    };

    var stroke = [
    	{
    		name: "stroke.prism.bin",
    		md5: "439f49c29f334fa9a4d2a695b69caefd"
    	},
    	{
    		name: "stroke.reverse.bin",
    		md5: "2a48d464df9af2b4d7357a0b7d14090f"
    	},
    	{
    		name: "stroke.schema.yaml",
    		md5: "44e4e9b9b7560c88374b6227816567d4"
    	},
    	{
    		name: "stroke.table.bin",
    		md5: "338d1760e7d1f9e964705436555d7681"
    	}
    ];
    var targetFiles = {
    	"luna-pinyin": [
    	{
    		name: "luna_pinyin.prism.bin",
    		md5: "3a830d0c8b0bc0d608e5329dfb8ff7e2"
    	},
    	{
    		name: "luna_pinyin.reverse.bin",
    		md5: "d16701cc9cc16ab74f3b60b336409bf1"
    	},
    	{
    		name: "luna_pinyin.schema.yaml",
    		md5: "436025a9bf0b619dc6ffe37aee346a07"
    	},
    	{
    		name: "luna_pinyin.table.bin",
    		md5: "153ea95bab6e4ee20abff0f5dfec6ead"
    	}
    ],
    	stroke: stroke,
    	"bczhc/rime-demo": [
    	{
    		name: "PY_c.prism.bin",
    		md5: "f82eb8913fbbbbdf426e1603da72131a"
    	},
    	{
    		name: "PY_c.reverse.bin",
    		md5: "e1064a2450749be4541e403d0e798d27"
    	},
    	{
    		name: "PY_c.schema.yaml",
    		md5: "ad5032a74c162f68549161d3f349eb52"
    	},
    	{
    		name: "PY_c.table.bin",
    		md5: "ed070ee3929791e58436b5a6ec5d3289"
    	},
    	{
    		name: "chaizi.prism.bin",
    		md5: "1ce2d5c52051bf4daee24b382677a55a"
    	},
    	{
    		name: "chaizi.reverse.bin",
    		md5: "6bbc242307c979e3e62ba646b8fa450a"
    	},
    	{
    		name: "chaizi.schema.yaml",
    		md5: "def0d1fb2fa7afb1dcaa760e0fc49243"
    	},
    	{
    		name: "chaizi.table.bin",
    		md5: "1614adfbe4ce1eae1837eb553102c85b"
    	},
    	{
    		name: "emoji.prism.bin",
    		md5: "50678222ac1dc1b477798e3aa3afe669"
    	},
    	{
    		name: "emoji.reverse.bin",
    		md5: "5dbf6af9602fe01d87957ce64444e8b7"
    	},
    	{
    		name: "emoji.schema.yaml",
    		md5: "2dce2753bd6fc569303b4cb4d303d48c"
    	},
    	{
    		name: "emoji.table.bin",
    		md5: "1aea3b68a50bfab2537bddcdcccb5672"
    	},
    	{
    		name: "html_chars.prism.bin",
    		md5: "2c34409587fee974dc76a04bdb0bc8bf"
    	},
    	{
    		name: "html_chars.reverse.bin",
    		md5: "a7b52faaafb223ce4152ddb4545da1d3"
    	},
    	{
    		name: "html_chars.schema.yaml",
    		md5: "c77cb117beb6e89d2fe2b4004485bef2"
    	},
    	{
    		name: "html_chars.table.bin",
    		md5: "7a6f7f3654052a90fdf8a33213ffe24a"
    	},
    	{
    		name: "ipa_yunlong.prism.bin",
    		md5: "4001d9dd24ba3df85d402474b4cc1592"
    	},
    	{
    		name: "ipa_yunlong.reverse.bin",
    		md5: "bb4ede9eca7365defaa9631dacf2d0c6"
    	},
    	{
    		name: "ipa_yunlong.schema.yaml",
    		md5: "5e00ef435c8d723e79b16f9b98c2f62c"
    	},
    	{
    		name: "ipa_yunlong.table.bin",
    		md5: "ca7388b30a151620453ef1684408c34f"
    	},
    	{
    		name: "kongmingma.prism.bin",
    		md5: "3111d005ac00b689905dc266e4de3496"
    	},
    	{
    		name: "kongmingma.reverse.bin",
    		md5: "9b319a6b5bb0fe58badea04b781ec134"
    	},
    	{
    		name: "kongmingma.schema.yaml",
    		md5: "cdd7d65ab2ea8d74b89d83a6e32b5f7a"
    	},
    	{
    		name: "kongmingma.table.bin",
    		md5: "377cc4b6bc81bbea927e47ac0d029de0"
    	},
    	{
    		name: "latin_international.prism.bin",
    		md5: "c63e3f15149ec65bf32cf13cbf91039f"
    	},
    	{
    		name: "latin_international.reverse.bin",
    		md5: "27ee49f7e0fcb1af1ffdc422831f5ff6"
    	},
    	{
    		name: "latin_international.schema.yaml",
    		md5: "438d4ea315af5091bc972ff51f49c883"
    	},
    	{
    		name: "latin_international.table.bin",
    		md5: "a19cde0f62456537a98d973cc3a32af2"
    	},
    	{
    		name: "named_ipa_diacritics.prism.bin",
    		md5: "c6d90ff4bfce7c22bb8d0934809742d5"
    	},
    	{
    		name: "named_ipa_diacritics.reverse.bin",
    		md5: "4c84a04962ff6ab6d8d75a52ac7f9ff1"
    	},
    	{
    		name: "named_ipa_diacritics.schema.yaml",
    		md5: "848f3a034af471b2da87433c3e3e87dc"
    	},
    	{
    		name: "named_ipa_diacritics.table.bin",
    		md5: "8eccd1b2a1750d8becde9b11c00d10d0"
    	},
    	{
    		name: "short_punct.prism.bin",
    		md5: "c4086ee778dd2c793d01e68153083f9f"
    	},
    	{
    		name: "short_punct.reverse.bin",
    		md5: "ad812213aadd7e2adaba6fc02ced5aa7"
    	},
    	{
    		name: "short_punct.schema.yaml",
    		md5: "2326e80fdbc4422197f56930748b89f0"
    	},
    	{
    		name: "short_punct.table.bin",
    		md5: "b3c49ff06fcb821acbab7eb4f72e3329"
    	},
    	{
    		name: "tiger.prism.bin",
    		md5: "be812c0d9b440cc27628b527d5387205"
    	},
    	{
    		name: "tiger.reverse.bin",
    		md5: "95c44ea57a3043f86776ab75252fe9b8"
    	},
    	{
    		name: "tiger.schema.yaml",
    		md5: "4eb6cdd97865c8d4b6c4fdc7da29455d"
    	},
    	{
    		name: "tiger.table.bin",
    		md5: "821b0cdbacf4455ddd21ce660cf0c38a"
    	},
    	{
    		name: "tiger_core2022.prism.bin",
    		md5: "1e72f2da305a396717b8bc779e144f71"
    	},
    	{
    		name: "tiger_core2022.reverse.bin",
    		md5: "dbf8d48d8eb053ca7221fe6148a95652"
    	},
    	{
    		name: "tiger_core2022.schema.yaml",
    		md5: "e7f943901f134b75eb152238917f4454"
    	},
    	{
    		name: "tiger_core2022.table.bin",
    		md5: "a774171b6bd3cafb9e5500ab5406f2b4"
    	},
    	{
    		name: "tiger_guihu.bootstrap.prism.bin",
    		md5: "5b87dc4fd793485006dbf27f94999288"
    	},
    	{
    		name: "tiger_guihu.bootstrap.reverse.bin",
    		md5: "f3896edded477eb2dbab7a7266490143"
    	},
    	{
    		name: "tiger_guihu.bootstrap.table.bin",
    		md5: "34a8a122b47b6a4e22373a3196b83b61"
    	},
    	{
    		name: "tiger_guihu.schema.yaml",
    		md5: "5cad2aca0a88fba68837dd0070297b0f"
    	},
    	{
    		name: "zrm_pinyin.prism.bin",
    		md5: "2700d114294680df76ef4ed5b15d861f"
    	},
    	{
    		name: "zrm_pinyin.reverse.bin",
    		md5: "2bfc7575d4c653670e37c991a34f8663"
    	},
    	{
    		name: "zrm_pinyin.schema.yaml",
    		md5: "9945c1204e0af5cc7bc3fc6c38221fb2"
    	},
    	{
    		name: "zrm_pinyin.table.bin",
    		md5: "1b8493ece171abe3558c2ffbbf9b31ed"
    	}
    ]
    };

    const HASH = 'hash';
    const CONTENT = 'content';
    const prefix = ('' + 'ime/');
    const dbPromise = openDB('ime', 1, {
        upgrade(db) {
            db.createObjectStore(HASH);
            db.createObjectStore(CONTENT);
        }
    });
    async function setIME(schemaId) {
        const fetched = [];
        function getFiles(key) {
            if (fetched.includes(key)) {
                return [];
            }
            fetched.push(key);
            const files = [];
            for (const dependency of dependencyMap[key] || []) {
                files.push(...getFiles(dependency));
            }
            const { dict, prism } = schemaFiles[key];
            const dictionary = dict || key;
            const tableBin = `${dictionary}.table.bin`;
            const reverseBin = `${dictionary}.reverse.bin`;
            const prismBin = `${prism || dictionary}.prism.bin`;
            const schemaYaml = `${key}.schema.yaml`;
            const target = schemaTarget[key];
            for (const fileName of [tableBin, reverseBin, prismBin, schemaYaml]) {
                for (const { name, md5 } of targetFiles[target]) {
                    if (fileName === name) {
                        files.push({ name, md5, target });
                        break;
                    }
                }
            }
            return files;
        }
        const files = getFiles(schemaId);
        const db = await dbPromise.catch(() => undefined); // not available in Firefox Private Browsing
        await Promise.all(files.map(async ({ name, target, md5 }) => {
            const path = `build/${name}`;
            try {
                Module.FS.lookupPath(path);
            }
            catch (e) { // not exists
                const storedHash = await db?.get(HASH, name);
                let ab;
                if (storedHash === md5) {
                    ab = await db.get(CONTENT, name);
                }
                else {
                    const response = await fetch(`${prefix}${target}/${name}`);
                    if (!response.ok) {
                        throw new Error(`Fail to download ${name}`);
                    }
                    ab = await response.arrayBuffer();
                    await db?.put(CONTENT, ab, name);
                    await db?.put(HASH, md5, name);
                }
                Module.FS.writeFile(path, new Uint8Array(ab));
            }
        }));
        Module.ccall('set_ime', 'null', ['string'], [schemaId]);
    }
    const readyPromise = loadWasm('rime.js', {
        url: '',
        init() {
            Module.ccall('init', 'null', [], []);
            Module.FS.mkdir('build');
        }
    });
    expose({
        setIME,
        setOption(option, value) {
            return Module.ccall('set_option', 'null', ['string', 'number'], [option, value]);
        },
        process(input) {
            return Module.ccall('process', 'string', ['string'], [input]);
        }
    }, readyPromise);

})();
