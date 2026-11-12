/** How a thought feels, from -2 (miserable) to 2 (delighted). */
export type Mood = -2 | -1 | 0 | 1 | 2;

export interface Thought {
  id: number;
  text: string;
  mood: Mood;
}

/** Ids of the thoughts guests have, by name. Ids 0 to 31 are reserved; later work adds to these. */
export const THOUGHT = {
  NONE: 0,
  GREAT_PARK: 1,
  TOO_EXPENSIVE: 2,
  HUNGRY: 3,
  THIRSTY: 4,
  TIRED: 5,
  NEED_TOILET: 6,
  LOST: 7,
  CROWDED: 8,
  NICE_VIEW: 9,
  GOING_HOME: 10,
  PARK_CLOSED: 11,
  RIDE_FUN: 12,
  RIDE_SICK: 13,
  QUEUE_TOO_LONG: 14,
  CANT_AFFORD_RIDE: 15,
} as const;

/** Every thought, indexed by id. */
export const THOUGHTS: readonly Thought[] = [
  { id: THOUGHT.NONE, text: "", mood: 0 },
  { id: THOUGHT.GREAT_PARK, text: "This park is great!", mood: 2 },
  { id: THOUGHT.TOO_EXPENSIVE, text: "This park is too expensive", mood: -2 },
  { id: THOUGHT.HUNGRY, text: "I'm hungry", mood: -1 },
  { id: THOUGHT.THIRSTY, text: "I'm thirsty", mood: -1 },
  { id: THOUGHT.TIRED, text: "I'm tired", mood: -1 },
  { id: THOUGHT.NEED_TOILET, text: "I need the toilet", mood: -1 },
  { id: THOUGHT.LOST, text: "I can't find my way", mood: -2 },
  { id: THOUGHT.CROWDED, text: "It's too crowded here", mood: -1 },
  { id: THOUGHT.NICE_VIEW, text: "What a lovely view", mood: 1 },
  { id: THOUGHT.GOING_HOME, text: "I'm going home", mood: -1 },
  { id: THOUGHT.PARK_CLOSED, text: "The park is closed", mood: -1 },
  { id: THOUGHT.RIDE_FUN, text: "That was fun!", mood: 2 },
  { id: THOUGHT.RIDE_SICK, text: "I feel sick", mood: -1 },
  { id: THOUGHT.QUEUE_TOO_LONG, text: "This queue is too long", mood: -1 },
  { id: THOUGHT.CANT_AFFORD_RIDE, text: "I can't afford this", mood: -1 },
];

/** What a guest says for thought `id`: "" for none, and for an id nobody has thought of yet. */
export function thoughtText(id: number): string {
  return THOUGHTS[id]?.text ?? "";
}
