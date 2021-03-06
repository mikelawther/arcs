/** @license
 * Copyright (c) 2017 Google Inc. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * Code distributed by Google as part of this project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
'use strict';

const Identifier = require('./identifier.js');
const Entity = require('./entity.js');
const Relation = require('./relation.js');
const Symbols = require('./symbols.js');
const underlyingView = require('./view.js');
let identifier = Symbols.identifier;
const assert = require("assert");
const ParticleSpec = require("./particle-spec.js");

// TODO: This won't be needed once runtime is transferred between contexts.
function cloneData(data) {
  return data;
  //return JSON.parse(JSON.stringify(data));
}

function restore(entry, entityClass) {
  let {id, rawData} = entry;
  var entity = new entityClass(cloneData(rawData));
  if (entry.id) {
    entity.identify(entry.id);
  }

  // TODO some relation magic, somewhere, at some point.

  return entity;
}

/** @class Viewlet
 * Base class for Views and Variables.
 */
class Viewlet {
  constructor(view, canRead, canWrite) {
    this._view = view;
    this.canRead = canRead;
    this.canWrite = canWrite;
  }
  underlyingView() {
    return this._view;
  }
  /** @method on(kind, callback, target)
   * Register for callbacks every time the requested kind of event occurs.
   * Events are grouped into delivery sets by target, which should therefore
   * be the recieving particle.
   */
  on(kind, callback, target) {
    return this._view.on(kind, callback, target);
  }

  synchronize(kind, modelCallback, callback, target) {
    return this._view.synchronize(kind, modelCallback, callback, target);
  }

  generateID() {
    assert(this._view.generateID);
    return this._view.generateID();
  }

  generateIDComponents() {
    assert(this._view.generateIDComponents);
    return this._view.generateIDComponents();
  }

  _serialize(entity) {
    if (!entity.isIdentified())
      entity.createIdentity(this.generateIDComponents());
    let id = entity[identifier];
    let rawData = entity.dataClone();
    return {
      id,
      rawData
    };
  }

  _restore(entry) {
    assert(this.entityClass, "Viewlets need entity classes for deserialization");
    return restore(entry, this.entityClass);
  }

  get type() {
    return this._view._type;
  }
  get name() {
    return this._view.name;
  }

  get _id() {
    return this._view._id;
  }

  toManifestString() {
    return `'${this._id}'`;
  }
}

/** @class View
 * A handle on a set of Entity data. Note that, as a set, a View can only contain
 * a single version of an Entity for each given ID. Further, no order is implied
 * by the set. A particle's manifest dictates the types of views that need to be
 * connected to that particle, and the current recipe identifies which views are
 * connected.
 */
class View extends Viewlet {
  constructor(view, canRead, canWrite) {
    // TODO: this should talk to an API inside the PEC.
    super(view, canRead, canWrite);
  }
  query() {
    // TODO: things
  }
  /** @method async toList()
   * Returns a list of the Entities contained by the View.
   * throws: Error if this view is not configured as a readable view (i.e. 'in' or 'inout')
     in the particle's manifest.
   */
  async toList() {
    // TODO: remove this and use query instead
    if (!this.canRead)
      throw new Error("View not readable");
    return (await this._view.toList()).map(a => this._restore(a));
  }

  /** @method store(entity)
   * Stores a new entity into the View.
   * throws: Error if this view is not configured as a writeable view (i.e. 'out' or 'inout')
     in the particle's manifest.
   */
  store(entity) {
    if (!this.canWrite)
      throw new Error("View not writeable");
    var serialization = this._serialize(entity);
    return this._view.store(serialization);
  }

  /** @method remove(entity)
   * Removes an entity from the View.
   * throws: Error if this view is not configured as a writeable view (i.e. 'out' or 'inout')
     in the particle's manifest.
   */
  remove(entity) {
    if (!this.canWrite)
      throw new Error("View not writeable");
    var serialization = this._serialize(entity);
    return this._view.remove(serialization.id);
  }

  async debugString() {
    var list = await this.toList();
    return list ? ('[' + list.map(p => p.debugString).join(", ") + ']') : 'undefined';
  }
}

/** @class Variable
 * A handle on a single entity. A particle's manifest dictates
 * the types of views that need to be connected to that particle, and
 * the current recipe identifies which views are connected.
 */
class Variable extends Viewlet {
  constructor(variable, canRead, canWrite) {
    super(variable, canRead, canWrite);
  }

  /** @method async get()
  * Returns the Entity contained by the Variable, or undefined if the Variable
  * is cleared.
  * throws: Error if this variable is not configured as a readable view (i.e. 'in' or 'inout')
    in the particle's manifest.
   */
  async get() {
    if (!this.canRead)
      throw new Error("View not readable");
    var result = await this._view.get();
    if (result == null)
      return undefined;
    if (this.type.isEntity)
      return this._restore(result);
    if (this.type.isInterface)
      return ParticleSpec.fromLiteral(result);
    return result;
  }

  /** @method set(entity)
   * Stores a new entity into the Variable, replacing any existing entity.
   * throws: Error if this variable is not configured as a writeable view (i.e. 'out' or 'inout')
     in the particle's manifest.
   */
  set(entity) {
    if (!this.canWrite)
      throw new Error("View not writeable");
    return this._view.set(this._serialize(entity));
  }

  /** @method clear()
   * Clears any entity currently in the Variable.
   * throws: Error if this variable is not configured as a writeable view (i.e. 'out' or 'inout')
     in the particle's manifest.
   */
  clear() {
    if (!this.canWrite)
      throw new Error("View not writeable");
    this._view.clear();
  }
  async debugString() {
    var value = await this.get();
    return value ? value.debugString : 'undefined';
  }
}

function viewletFor(view, isView, canRead, canWrite) {
  if (canRead == undefined)
    canRead = true;
  if (canWrite == undefined)
    canWrite = true;
  if (isView || (isView == undefined && view instanceof underlyingView.View))
    view = new View(view, canRead, canWrite);
  else
    view = new Variable(view, canRead, canWrite);
  return view;
}

module.exports = { viewletFor };
