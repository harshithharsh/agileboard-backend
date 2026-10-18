// Sprint goal: the issues tagged as goal items, an outcome suggested from them, and the
// outcome a Scrum Master recorded (which always wins over the suggestion).
export const OUTCOMES = ['met', 'partly_met', 'not_met'];

// Suggestion from the goal-tagged issues once a sprint has closed:
// all done -> met, some -> partly met, none -> not met. No tagged issues, or still running -> none.
export function suggestOutcome(goalItems, sprintStatus) {
  const total = goalItems.length;
  const done = goalItems.filter((i) => i.done).length;
  if (!total || sprintStatus === 'active') return { done, total, suggestion: null };
  return { done, total, suggestion: done === total ? 'met' : done > 0 ? 'partly_met' : 'not_met' };
}

// Of the closed sprints with a recorded outcome, how many met their goal
export function hitRate(sprints, outcomesBySprint) {
  const recorded = sprints.filter((s) => s.status === 'completed' && outcomesBySprint.has(s.id));
  const count = (value) => recorded.filter((s) => outcomesBySprint.get(s.id).outcome === value).length;
  return { recorded: recorded.length, met: count('met'), partlyMet: count('partly_met'), notMet: count('not_met') };
}
