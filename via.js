"use strict";

{
	// Namespace (note the uppercase)
	self.Via = {};

	importScripts("viaObject.js", "viaProperty.js");
	
	// Symbols used to look up the hidden values behind the Proxy objects.
	Via.__TargetSymbol = Symbol();
	Via.__ObjectSymbol = Symbol();
	
	let nextObjectId = 1;							// next object ID to allocate
	const queue = [];								// queue of messages waiting to post
	let nextGetId = 0;								// next get request ID to allocate
	const pendingGetResolves = new Map();			// map of get request ID -> promise resolve function
	let nextFlushId = 0;							// next flush ID to allocate
	const pendingFlushResolves = new Map();			// map of flush ID -> promise resolve function
	let isPendingFlush = false;						// has set a flush to run at the next microtask
	
	// Callback functions are assigned an ID which is passed to a call's arguments.
	// The main thread creates a shim which forwards the callback back to the worker, where
	// it's looked up in the map by its ID again and then the worker-side callback invoked.
	let nextCallbackId = 0;
	const callbackToId = new Map();
	const idToCallback = new Map();
	
	// Create a default 'via' object (note the lowercase) representing the
	// global window object on the main thread
	self.via = Via._MakeObject(0);
	
	Via._GetNextObjectId = function ()
	{
		return nextObjectId++;
	};
	
	Via._AddToQueue = function (d)
	{
		queue.push(d);
		
		// Automatically flush queue at next microtask
		if (!isPendingFlush)
		{
			isPendingFlush = true;
			Promise.resolve().then(Via.Flush);
		}
	};
	
	// Post the queue to the main thread. Returns a promise which resolves when the main thread
	// has finished executing all the commands.
	Via.Flush = function ()
	{
		isPendingFlush = false;
		
		if (!queue.length)
			return Promise.resolve();
		
		const flushId = nextFlushId++;
		
		Via.postMessage({
			"cmds": queue,
			"flushId": flushId
		});
		
		queue.length = 0;
		
		return new Promise(resolve =>
		{
			pendingFlushResolves.set(flushId, resolve);
		});
	};
	
	// Called when a message received from the main thread
	Via.OnMessage = function (data)
	{
		if (data.type === "done")
			OnDone(data);
		else if (data.type === "callback")
			OnCallback(data);
		else
			throw new Error("invalid message type: " + data.type);
	};

	// Called when the main thread has finished a batch of commands passed by a flush.
	function OnDone(data)
	{
		// Resolve any pending get requests with the values retrieved from the main thread.
		const getResults = data.getResults;
		for (const [getId, valueData] of data.getResults)
		{
			const resolve = pendingGetResolves.get(getId);
			if (!resolve)
				throw new Error("invalid get id");
			
			pendingGetResolves.delete(getId);
			resolve(Via._UnwrapArg(valueData));
		}
		
		// Resolve the promise returned by the original Flush() call.
		const flushId = data.flushId;
		const flushResolve = pendingFlushResolves.get(flushId);
		if (!flushResolve)
			throw new Error("invalid flush id");
		
		pendingFlushResolves.delete(flushId);
		flushResolve();
	}
	
	// Called when a callback is invoked on the main thread and this was forwarded to the worker.
	function OnCallback(data)
	{
		const func = idToCallback.get(data.id);
		if (!func)
			throw new Error("invalid callback id");
		
		const args = data.args.map(Via._UnwrapArg);
		func(...args);
	}
	
	function GetCallbackId(func)
	{
		// Lazy-create IDs
		let id = callbackToId.get(func);
		
		if (typeof id === "undefined")
		{
			id = nextCallbackId++;
			callbackToId.set(func, id);
			idToCallback.set(id, func);
		}
		
		return id;
	}
	
	function CanStructuredClone(o)
	{
		const type = typeof o;
		return type === "undefined" || o === null || type === "boolean" || type === "number" || type === "string" ||
				(o instanceof Blob) || (o instanceof ArrayBuffer) || (o instanceof ImageData);
	}

	// Wrap an argument to a small array representing the value, object, property or callback for
	// posting to the main thread.
	Via._WrapArg = function(arg)
	{
		// The Proxy objects used for objects and properties identify as functions.
		// Use the special accessor symbols to see what they really are. If they're not a Proxy
		// that Via knows about, assume it is a callback function instead.
		if (typeof arg === "function")
		{
			// Identify Via object proxy by testing if its object symbol returns a number
			const objectId = arg[Via.__ObjectSymbol];
			if (typeof objectId === "number")
			{
				return [1 /* object */, objectId];
			}
			
			// Identify Via property proxy by testing if its target symbol returns anything
			const propertyTarget = arg[Via.__TargetSymbol];
			
			if (propertyTarget)
			{
				return [3 /* object property */, propertyTarget._objectId, propertyTarget._path];
			}
			
			// Neither symbol applied; assume an ordinary callback function
			return [2 /* callback */, GetCallbackId(arg)];
		}
		// Pass basic types that can be transferred via postMessage as-is.
		else if (CanStructuredClone(arg))
		{
			return [0 /* primitive */, arg];
		}
		else
			throw new Error("invalid argument");
	}
	
	// Unwrap an argument for a callback sent by the main thread.
	Via._UnwrapArg = function (arr)
	{
		switch (arr[0])	{
		case 0:		// primitive
			return arr[1];
		case 1:		// object
			return Via._MakeObject(arr[1]);
		default:
			throw new Error("invalid arg type");
		}
	}
	
	// Add a command to the queue representing a get request.
	function AddGet(objectId, path)
	{
		const getId = nextGetId++;
		
		Via._AddToQueue([2 /* get */, getId, objectId, path]);
		
		return new Promise(resolve =>
		{
			pendingGetResolves.set(getId, resolve);
		});
	};

	// Return a promise that resolves with the real value of a property, e.g. get(via.document.title).
	// This involves a message round-trip, but multiple gets can be requested in parallel, and they will
	// all be processed in the same round-trip.
	self.get = async function (proxy)
	{
		if (typeof proxy === "function")
		{
			const target = proxy[Via.__TargetSymbol];
			if (!target)
			{
				const objectId = proxy[Via.__ObjectSymbol];
				
				if (typeof objectId === "number")
				{
					return AddGet(objectId, null);
				}
				else
				{
					return proxy;
				}
			}
			
			return AddGet(target._objectId, target._path);
		}
		else
		{
			return proxy;
		}
	}
	
	// Clear the ID maps on the main thread as a poor attempt to avoid a memory leak.
	Via.ResetReferences = function ()
	{
		Via._AddToQueue([3 /* reset */]);
	};
}