/**
 * @license
 * Copyright (c) 2017 Google Inc. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * Code distributed by Google as part of this project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
"use strict";

const assert = require('assert');
const ParticleSpec = require('./particle-spec.js');
const Type = require('./type.js');

class ThingMapper {
  constructor(prefix) {
    this._prefix = prefix;
    this._nextIdentifier = 0;
    this._idMap = new Map();
    this._reverseIdMap = new Map();
  }

  _newIdentifier() {
    return this._prefix + (this._nextIdentifier++);
  }

  createMappingForThing(thing) {
    assert(!this._reverseIdMap.has(thing));
    var id = this._newIdentifier();
    this.establishThingMapping(id, thing);
    return id;
  }

  maybeCreateMappingForThing(thing) {
    if (this.hasMappingForThing(thing)) {
      return this.identifierForThing(thing);
    }
    return this.createMappingForThing(thing);
  }

  establishThingMapping(id, thing) {
    let continuation;
    if (Array.isArray(thing)) {
      [thing, continuation] = thing;
    }
    this._idMap.set(id, thing);
    if (thing instanceof Promise) {
      assert(continuation == null);
      thing.then(actualThing => this.establishThingMapping(id, actualThing));
    } else {
      this._reverseIdMap.set(thing, id);
      if (continuation) {
        continuation();
      }
    }
  }

  hasMappingForThing(thing) {
    return this._reverseIdMap.has(thing);
  }

  identifierForThing(thing) {
    assert(this._reverseIdMap.has(thing), `Missing thing ${thing}`);
    return this._reverseIdMap.get(thing);
  }

  thingForIdentifier(id) {
    assert(this._idMap.has(id), `Missing id: ${id}`);
    return this._idMap.get(id);
  }
}


class APIPort {
  constructor(messagePort, prefix) {
    this._port = messagePort;
    this._mapper = new ThingMapper(prefix);
    this._messageMap = new Map();
    this._port.onmessage = e => this._handle(e);
    this.messageCount = 0;

    this.Direct = {
      convert: a => a,
      unconvert: a => a
    }

    this.Stringify = {
      convert: a => a.toString(),
      unconvert: a => eval(a)
    }

    this.LocalMapped = {
      convert: a => this._mapper.maybeCreateMappingForThing(a),
      unconvert: a => this._mapper.thingForIdentifier(a)
    }

    this.Mapped = {
      convert: a => this._mapper.identifierForThing(a),
      unconvert: a => this._mapper.thingForIdentifier(a)
    }

    this.Dictionary = function(primitive) {
      return {
        convert: a => {
          var r = {};
          for (var key in a) {
            r[key] = primitive.convert(a[key]);
          }
          return r;
        }
      }
    }

    this.Map = function(keyprimitive, valueprimitive) {
      return {
        convert: a => {
          var r = {};
          a.forEach((value, key) => r[keyprimitive.convert(key)] = valueprimitive.convert(value));
          return r;
        },
        unconvert: a => {
          var r = new Map();
          for (var key in a)
            r.set(keyprimitive.unconvert(key), valueprimitive.unconvert(a[key]));
          return r;
        }
      }
    }

    this.List = function(primitive) {
      return {
        convert: a => a.map(v => primitive.convert(v)),
        unconvert: a => a.map(v => primitive.unconvert(v))
      }
    }

    this.ByLiteral = function(clazz) {
      return {
        convert: a => a.toLiteral(),
        unconvert: a => clazz.fromLiteral(a)
      }
    }
  }

  close() {
    this._port.close();
  }

  _handle(e) {
    assert(this._messageMap.has(e.data.messageType));

    this.messageCount++;

    let handler = this._messageMap.get(e.data.messageType);
    let args;
    try {
      args = this._unprocessArguments(handler.args, e.data.messageBody);
    } catch (exc) {
      console.error(`Exception during unmarshaling for ${e.data.messageType}`);
      throw exc;
    }
    // If any of the converted arguments are still pending promises
    // wait for them to complete before processing the message.
    for (let arg of Object.values(args)) {
      if (arg instanceof Promise) {
        arg.then(() => this._handle(e));
        return;
      }
    }
    let result = this["on" + e.data.messageType](args);
    if (handler.isInitializer) {
      assert(args.identifier);
      this._mapper.establishThingMapping(args.identifier, result);
    }
  }

  _processArguments(argumentTypes, args) {
    var messageBody = {};
    for (var argument in argumentTypes)
      messageBody[argument] = argumentTypes[argument].convert(args[argument]);
    return messageBody;
  }

  _unprocessArguments(argumentTypes, args) {
    var messageBody = {};
    for (var argument in argumentTypes)
      messageBody[argument] = argumentTypes[argument].unconvert(args[argument]);
    return messageBody;
  }

  registerCall(name, argumentTypes) {
    this[name] = args => {
      var call = { messageType: name, messageBody: this._processArguments(argumentTypes, args) };
      this._port.postMessage(call);
    };
  }

  registerHandler(name, argumentTypes) {
    this._messageMap.set(name, {args: argumentTypes});
  }

  registerInitializerHandler(name, argumentTypes) {
    argumentTypes.identifier = this.Direct;
    this._messageMap.set(name, {
      isInitializer: true,
      args: argumentTypes,
    });
  }

  registerInitializer(name, argumentTypes) {
    this[name] = (thing, args) => {
      var call = { messageType: name, messageBody: this._processArguments(argumentTypes, args) };
      call.messageBody.identifier = this._mapper.createMappingForThing(thing);
      this._port.postMessage(call);
    };
  }

  registerRedundantInitializer(name, argumentTypes) {
    this[name] = (thing, args) => {
      if (this._mapper.hasMappingForThing(thing))
        return;
      var call = { messageType: name, messageBody: this._processArguments(argumentTypes, args) };
      call.messageBody.identifier = this._mapper.createMappingForThing(thing);
      this._port.postMessage(call);
    };
  }
}

class PECOuterPort extends APIPort {
  constructor(messagePort) {
    super(messagePort, 'o');

    this.registerCall("Stop", {});
    this.registerCall("DefineParticle",
      {particleDefinition: this.Direct, particleFunction: this.Stringify});
    this.registerRedundantInitializer("DefineView", {viewType: this.ByLiteral(Type), name: this.Direct})
    this.registerInitializer("InstantiateParticle",
      {spec: this.ByLiteral(ParticleSpec), views: this.Map(this.Direct, this.Mapped)});

    this.registerCall("UIEvent", {particle: this.Mapped, slotName: this.Direct, event: this.Direct});
    this.registerCall("SimpleCallback", {callback: this.Direct, data: this.Direct});
    this.registerCall("AwaitIdle", {version: this.Direct});
    this.registerCall("StartRender", {particle: this.Mapped, slotName: this.Direct, contentTypes: this.List(this.Direct)});
    this.registerCall("StopRender", {particle: this.Mapped, slotName: this.Direct});

    this.registerHandler("Render", {particle: this.Mapped, slotName: this.Direct, content: this.Direct});
    this.registerHandler("Synchronize", {view: this.Mapped, target: this.Mapped,
                                    type: this.Direct, callback: this.Direct,
                                    modelCallback: this.Direct});
    this.registerHandler("ViewGet", {view: this.Mapped, callback: this.Direct});
    this.registerHandler("ViewToList", {view: this.Mapped, callback: this.Direct});
    this.registerHandler("ViewSet", {view: this.Mapped, data: this.Direct});
    this.registerHandler("ViewStore", {view: this.Mapped, data: this.Direct});
    this.registerHandler("ViewRemove", {view: this.Mapped, data: this.Direct});
    this.registerHandler("ViewClear", {view: this.Mapped});
    this.registerHandler("Idle", {version: this.Direct, relevance: this.Map(this.Mapped, this.Direct)});

    this.registerHandler("ConstructInnerArc", {callback: this.Direct, particle: this.Mapped});
    this.registerCall("ConstructArcCallback", {callback: this.Direct, arc: this.LocalMapped});

    this.registerHandler("ArcCreateView", {callback: this.Direct, arc: this.LocalMapped, viewType: this.ByLiteral(Type), name: this.Direct});
    this.registerInitializer("CreateViewCallback", {callback: this.Direct, viewType: this.ByLiteral(Type), name: this.Direct, id: this.Direct});

    this.registerHandler("ArcCreateSlot",
      { callback: this.Direct, arc: this.LocalMapped, transformationParticle: this.Mapped, transformationSlotName: this.Direct, hostedParticleName: this.Direct, hostedSlotName: this.Direct});
    this.registerInitializer("CreateSlotCallback", {callback: this.Direct, hostedSlotId: this.Direct});
    this.registerCall("InnerArcRender", { transformationParticle: this.Mapped, transformationSlotName: this.Direct, hostedSlotId: this.Direct, content: this.Direct});

    this.registerHandler("ArcLoadRecipe", {arc: this.LocalMapped, recipe: this.Direct, callback: this.Direct});
  }
}

class PECInnerPort extends APIPort {
  constructor(messagePort) {
    super(messagePort, 'i');

    this.registerHandler("Stop", {});
    // particleFunction needs to be eval'd in context or it won't work.
    this.registerHandler("DefineParticle",
      {particleDefinition: this.Direct, particleFunction: this.Direct});
    this.registerInitializerHandler("DefineView", {viewType: this.ByLiteral(Type), name: this.Direct});
    this.registerInitializerHandler("InstantiateParticle",
      {spec: this.ByLiteral(ParticleSpec), views: this.Map(this.Direct, this.Mapped)});

    this.registerHandler("UIEvent", {particle: this.Mapped, slotName: this.Direct, event: this.Direct});
    this.registerHandler("SimpleCallback", {callback: this.LocalMapped, data: this.Direct});
    this.registerHandler("AwaitIdle", {version: this.Direct});
    this.registerHandler("StartRender", {particle: this.Mapped, slotName: this.Direct, contentTypes: this.Direct});
    this.registerHandler("StopRender", {particle: this.Mapped, slotName: this.Direct});

    this.registerCall("Render", {particle: this.Mapped, slotName: this.Direct, content: this.Direct});
    this.registerCall("Synchronize", {view: this.Mapped, target: this.Mapped,
                                 type: this.Direct, callback: this.LocalMapped,
                                 modelCallback: this.LocalMapped});
    this.registerCall("ViewGet", {view: this.Mapped, callback: this.LocalMapped});
    this.registerCall("ViewToList", {view: this.Mapped, callback: this.LocalMapped});
    this.registerCall("ViewSet", {view: this.Mapped, data: this.Direct});
    this.registerCall("ViewStore", {view: this.Mapped, data: this.Direct});
    this.registerCall("ViewRemove", {view: this.Mapped, data: this.Direct});
    this.registerCall("ViewClear", {view: this.Mapped});
    this.registerCall("Idle", {version: this.Direct, relevance: this.Map(this.Mapped, this.Direct)});

    this.registerCall("ConstructInnerArc", {callback: this.LocalMapped, particle: this.Mapped});
    this.registerHandler("ConstructArcCallback", {callback: this.LocalMapped, arc: this.Direct});

    this.registerCall("ArcCreateView", {callback: this.LocalMapped, arc: this.Direct, viewType: this.ByLiteral(Type), name: this.Direct});
    this.registerInitializerHandler("CreateViewCallback", {callback: this.LocalMapped, viewType: this.ByLiteral(Type), name: this.Direct, id: this.Direct});
    this.registerCall("ArcCreateSlot",
      {callback: this.LocalMapped, arc: this.Direct, transformationParticle: this.Mapped, transformationSlotName: this.Direct, hostedParticleName: this.Direct, hostedSlotName: this.Direct});
    this.registerInitializerHandler("CreateSlotCallback", { callback: this.LocalMapped, hostedSlotId: this.Direct });
    this.registerHandler("InnerArcRender", {transformationParticle: this.Mapped, transformationSlotName: this.Direct, hostedSlotId: this.Direct, content: this.Direct});

    this.registerCall("ArcLoadRecipe", {arc: this.Direct, recipe: this.Direct, callback: this.LocalMapped});
  }
}

module.exports = { PECOuterPort, PECInnerPort };
