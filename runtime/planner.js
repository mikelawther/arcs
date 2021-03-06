// Copyright (c) 2017 Google Inc. All rights reserved.
// This code may only be used under the BSD style license found at
// http://polymer.github.io/LICENSE.txt
// Code distributed by Google as part of this project is also
// subject to an additional IP rights grant found at
// http://polymer.github.io/PATENTS.txt

let {Strategy, Strategizer} = require('../strategizer/strategizer.js');
var assert = require("assert");
let Recipe = require('./recipe/recipe.js');
let RecipeUtil = require('./recipe/recipe-util.js');
let RecipeWalker = require('./recipe/walker.js');
let ConvertConstraintsToConnections = require('./strategies/convert-constraints-to-connections.js');
let AssignRemoteViews = require('./strategies/assign-remote-views.js');
let CopyRemoteViews = require('./strategies/copy-remote-views.js');
let AssignViewsByTagAndType = require('./strategies/assign-views-by-tag-and-type.js');
let InitPopulation = require('./strategies/init-population.js');
let MapConsumedSlots = require('./strategies/map-consumed-slots.js');
let MapRemoteSlots = require('./strategies/map-remote-slots.js');
let MatchParticleByVerb = require('./strategies/match-particle-by-verb.js');
let NameUnnamedConnections = require('./strategies/name-unnamed-connections.js');
let AddUseViews = require('./strategies/add-use-views.js');
let Manifest = require('./manifest.js');
let InitSearch = require('./strategies/init-search.js');
let SearchTokensToParticles = require('./strategies/search-tokens-to-particles.js');
let FallbackFate = require('./strategies/fallback-fate.js');
let GroupViewConnections = require('./strategies/group-view-connections.js');
let CombinedStrategy = require('./strategies/combined-strategy.js');

const Speculator = require('./speculator.js');
const Description = require('./description.js');
const Tracing = require('tracelib');

class CreateViews extends Strategy {
  // TODO: move generation to use an async generator.
  async generate(strategizer) {
    var results = Recipe.over(this.getResults(strategizer), new class extends RecipeWalker {
      onView(recipe, view) {
        var counts = RecipeUtil.directionCounts(view);

        var score = 1;
        if (counts.in == 0 || counts.out == 0) {
          if (counts.unknown > 0)
            return;
          if (counts.in == 0)
            score = -1;
          else
            score = 0;
        }

        if (!view.id && view.fate == "?") {
          return (recipe, view) => {view.fate = "create"; return score}
        }
      }
    }(RecipeWalker.Permuted), this);

    return { results, generate: null };
  }
}


class Planner {
  // TODO: Use context.arc instead of arc
  init(arc) {
    this._arc = arc;
    let strategies = [
      new InitPopulation(arc),
      new InitSearch(arc),
      new CombinedStrategy([
        new SearchTokensToParticles(arc),
        new GroupViewConnections(),
      ]),
      new FallbackFate(),
      new CreateViews(),
      new AssignViewsByTagAndType(arc),
      new ConvertConstraintsToConnections(arc),
      new MapConsumedSlots(),
      new AssignRemoteViews(arc),
      new CopyRemoteViews(arc),
      new MapRemoteSlots(arc),
      new MatchParticleByVerb(arc),
      new NameUnnamedConnections(arc),
      new AddUseViews(),
    ];
    this.strategizer = new Strategizer(strategies, [], {
      maxPopulation: 100,
      generationSize: 100,
      discardSize: 20,
    });
  }

  async generate() {
    var log = await this.strategizer.generate();
    return this.strategizer.generated;
  }

  async plan(timeout, generations) {
    let trace = Tracing.async({cat: 'planning', name: 'Planner::plan', args: {timeout}})
    timeout = timeout || NaN;
    let allResolved = [];
    let now = () => global.performance ? performance.now() : process.hrtime();
    let start = now();
    do {
      let generated = await trace.wait(() => this.generate());
      trace.resume({args: {
        generated: this.strategizer.generated.length,
      }});
      if (generations) {
        generations.push(generated);
      }

      let resolved = this.strategizer.generated
          .map(individual => individual.result)
          .filter(recipe => recipe.isResolved());
      allResolved.push(...resolved);
      if (now() - start > timeout) {
        console.warn('Planner.plan timed out.');
        break;
      }
    } while (this.strategizer.generated.length > 0);
    trace.end();
    return allResolved;
  }

  _matchesActiveRecipe(plan) {
    var planShape = RecipeUtil.recipeToShape(plan);
    var result = RecipeUtil.find(this._arc._activeRecipe, planShape);
    return result[0].score == 0;
  }

  async suggest(timeout, generations) {
    let trace = Tracing.async({cat: 'planning', name: 'Planner::suggest', args: {timeout}})
    let plans = await trace.wait(() => this.plan(timeout, generations));
    trace.resume();
    let suggestions = [];
    let speculator = new Speculator();
    // TODO: Run some reasonable number of speculations in parallel.
    let results = [];
    for (let plan of plans) {
      let hash = ((hash) => { return hash.substring(hash.length - 4)}) (await plan.digest());

      if (this._matchesActiveRecipe(plan)) {
        this._updateGeneration(generations, hash, (g) => g.active = true);
        continue;
      }

      let relevance = await trace.wait(() => speculator.speculate(this._arc, plan));
      trace.resume();
      if (!relevance.isRelevant()) {
        continue;
      }
      let rank = relevance.calcRelevanceScore();

      let description = Description.getSuggestion(relevance.newArc.recipes[relevance.newArc.recipes.length - 1],
                                                  relevance.newArc);

      this._updateGeneration(generations, hash, (g) => g.description = description);

      // TODO: Move this logic inside speculate, so that it can stop the arc
      // before returning.
      relevance.newArc.stop();

      // Filter plans based on arc._search string.
      if (this._arc.search) {
        if (!plan.search) {
          // This plan wasn't constructed based on the provided search terms.
          if (description.toLowerCase().indexOf(arc.search) < 0) {
            // Description must contain the full search string.
            // TODO: this could be a strategy, if description was already available during strategies execution.
            continue;
          }
        } else {
          // This mean the plan was constructed based on provided search terms,
          // and at least one of them were resolved (in order for the plan to be resolved).
        }
      }

      results.push({
        plan,
        rank,
        description,
        hash
      });
    }
    trace.end();
    return results;
  }
  _updateGeneration(generations, hash, handler) {
    if (generations) {
      generations.forEach(g => {
        g.forEach(gg => {
          if (gg.hash.endsWith(hash)) {
            handler(gg);
          }
        });
      });
    }
  }
}

module.exports = Planner;
