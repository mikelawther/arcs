/**
 * @license
 * Copyright (c) 2017 Google Inc. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * Code distributed by Google as part of this project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

const Manifest = require('../manifest.js');
const assert = require('chai').assert;
const util = require('./test-util.js');
const viewlet = require('../viewlet.js');
const Arc = require("../arc.js");
const MessageChannel = require("../message-channel.js");
const InnerPec = require("../inner-PEC.js");
const Loader = require("../loader.js");
const Recipe = require("../recipe/recipe.js");
const Type = require("../type.js");
const Shape = require("../shape.js");
const ParticleSpec = require("../particle-spec.js");

describe('particle-shape-loading', function() {

  it('loads shapes into particles', async () => {
    var loader = new class extends Loader {
      loadResource(path) {
        if (path == 'outer-particle.js')
          return `
          "use strict";

          defineParticle(({Particle}) => {
            return class P extends Particle {
              async setViews(views) {
                let arc = await this.constructInnerArc();
                var inputView = views.get('input');
                let outputView = views.get('output');
                let inView = await arc.createView(inputView.type, "input");
                let outView = await arc.createView(outputView.type, "output");
                let particle = await views.get('particle').get();

                var recipe = \`
                  schema Foo
                    optional
                      Text value
                  schema Bar
                    optional
                      Text value

                  particle \${particle.name} in '\${particle.implFile}'
                    \${particle.name}(in Foo foo, out Bar bar)

                  recipe
                    use '\${inView._id}' as v1
                    use '\${outView._id}' as v2
                    \${particle.name}
                      foo <- v1
                      bar -> v2
                \`;
                try {
                  await arc.loadRecipe(recipe);
                  var input = await inputView.get();
                  inView.set(input);
                  outView.on('change', async () => {
                    var output = await outView.get();
                    if (output !== undefined)
                      outputView.set(output);
                  }, this);
                } catch (e) {
                  console.log(e);
                }
              }
            }
          });
          `;
        return super.loadResource(path);
      }
    }();

    var pecFactory = function(id) {
      var channel = new MessageChannel();
      new InnerPec(channel.port1, `${id}:inner`, loader);
      return channel.port2;
    };

    var arc = new Arc({id: 'test', pecFactory});

    let manifest = await Manifest.load('../particles/test/test-particles.manifest', loader);

    let fooType = Type.newEntity(manifest.schemas.Foo.toLiteral());
    let barType = Type.newEntity(manifest.schemas.Bar.toLiteral());

    let shape = new Shape([{type: fooType}, {type: barType}], []);

    let shapeType = Type.newShape(shape);

    let outerParticleSpec = new ParticleSpec({
      name: 'outerParticle',
      implFile: 'outer-particle.js',
      args: [
        {direction: 'host', type: shapeType, name: 'particle'},
        {direction: 'in', type: fooType, name: 'input'},
        {direction: 'out', type: barType, name: 'output'}
      ],
    }, a => a);

    let shapeView = arc.createView(shapeType);
    shapeView.set(manifest.particles[0].toLiteral());
    let outView = arc.createView(barType);
    let inView = arc.createView(fooType);
    var Foo = manifest.schemas.Foo.entityClass();
    inView.set(new Foo({value: 'a foo'}))

    let recipe = new Recipe();
    let particle = recipe.newParticle("outerParticle");
    particle.spec = outerParticleSpec;

    let recipeShapeView = recipe.newView();
    particle.connections['particle'].connectToView(recipeShapeView);
    recipeShapeView.fate = 'use';
    recipeShapeView.mapToView(shapeView);

    let recipeOutView = recipe.newView();
    particle.connections['output'].connectToView(recipeOutView);
    recipeOutView.fate = 'use';
    recipeOutView.mapToView(outView);

    let recipeInView = recipe.newView();
    particle.connections['input'].connectToView(recipeInView);
    recipeInView.fate = 'use';
    recipeInView.mapToView(inView);

    assert(recipe.normalize(), "can't normalize recipe");
    assert(recipe.isResolved(), "recipe isn't resolved");

    arc.instantiate(recipe);

    await util.assertSingletonWillChangeTo(outView, manifest.schemas.Bar.entityClass(), "a foo1");

  });
});