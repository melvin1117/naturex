import { afterEach, describe, expect, it } from "vitest";

import {
  focusIfLost,
  markCommunityCreated,
  takeCommunityCreated,
} from "@/components/steward/focus";

afterEach(() => {
  document.body.innerHTML = "";
});

function region() {
  const el = document.createElement("section");
  el.tabIndex = -1;
  document.body.append(el);
  return el;
}

describe("focusIfLost (T48)", () => {
  it("takes focus that fell back to the page", () => {
    const target = region();
    focusIfLost(target);
    expect(document.activeElement).toBe(target);
  });

  it("never pulls focus from where the person is", () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    focusIfLost(region());
    expect(document.activeElement).toBe(field);
  });

  it("ignores a target that isn't there", () => {
    expect(() => focusIfLost(null)).not.toThrow();
  });
});

describe("a just-created community", () => {
  it("is reported once", () => {
    expect(takeCommunityCreated()).toBe(false);
    markCommunityCreated();
    expect(takeCommunityCreated()).toBe(true);
    expect(takeCommunityCreated()).toBe(false);
  });
});
