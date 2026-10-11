/**
 * Starting points for a new smart playlist: one click fills the rules,
 * which are then edited like any others. A blank page asks someone to know
 * Navidrome's fields before they have seen a single one.
 */

import { newRule, type RuleNode, type SmartRules, type Sort, withOperator } from './smartRules'

export interface Preset {
  /** Also the i18n key under smartPlaylists.presets. */
  id: string
  icon: string
  build(): Pick<SmartRules, 'children' | 'sort' | 'limit'>
}

function rule(field: string, operator: RuleNode['operator'], value: RuleNode['value']): RuleNode {
  return { ...withOperator(newRule(field), operator), value }
}

function sortBy(field: string, descending: boolean): Sort {
  return { field, descending }
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'recentlyAdded',
    icon: 'mdi-new-box',
    build: () => ({
      children: [rule('dateadded', 'inTheLast', 30)],
      sort: sortBy('dateadded', true),
      limit: null,
    }),
  },
  {
    id: 'neverPlayed',
    icon: 'mdi-play-circle-outline',
    build: () => ({
      children: [rule('playcount', 'is', 0)],
      sort: sortBy('random', false),
      limit: 100,
    }),
  },
  {
    id: 'forgotten',
    icon: 'mdi-history',
    // Played before, so not the same list as "never played".
    build: () => ({
      children: [rule('playcount', 'gt', 2), rule('lastplayed', 'notInTheLast', 180)],
      sort: sortBy('random', false),
      limit: 100,
    }),
  },
  {
    id: 'loved',
    icon: 'mdi-heart',
    build: () => ({
      children: [rule('loved', 'is', true)],
      sort: sortBy('random', false),
      limit: null,
    }),
  },
  {
    id: 'topRated',
    icon: 'mdi-star',
    build: () => ({
      children: [rule('rating', 'gt', 3)],
      sort: sortBy('rating', true),
      limit: null,
    }),
  },
  {
    id: 'decade',
    icon: 'mdi-calendar-range',
    build: () => ({
      children: [rule('year', 'inTheRange', [1990, 1999])],
      sort: sortBy('year', false),
      limit: null,
    }),
  },
  {
    id: 'noGenre',
    icon: 'mdi-tag-off-outline',
    build: () => ({
      children: [rule('genre', 'isMissing', null)],
      sort: sortBy('artist', false),
      limit: null,
    }),
  },
]
