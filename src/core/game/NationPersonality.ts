import { simpleHash } from "../Util";

export const NATION_PERSONALITIES = [
  {
    name: "expansionist",
    aggression: "relentless",
    description: "commits larger armies and accepts risky offensives",
    commitment: 0.38,
    tolerance: 0.7,
    interval: 60,
    recovery: 200,
    allies: 2,
  },
  {
    name: "defender",
    aggression: "measured",
    description: "values secure borders and keeps larger reserves",
    commitment: 0.22,
    tolerance: 1.05,
    interval: 120,
    recovery: 400,
    allies: 3,
  },
  {
    name: "merchant",
    aggression: "cautious",
    description: "prefers reliable partners and favorable wars",
    commitment: 0.25,
    tolerance: 1.15,
    interval: 150,
    recovery: 450,
    allies: 3,
  },
  {
    name: "opportunist",
    aggression: "assertive",
    description: "favors distracted rivals and shared enemies",
    commitment: 0.32,
    tolerance: 0.85,
    interval: 90,
    recovery: 300,
    allies: 2,
  },
] as const;

export function nationPersonality(id: string) {
  return NATION_PERSONALITIES[
    (simpleHash(id) >>> 0) % NATION_PERSONALITIES.length
  ];
}
