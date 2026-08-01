import { BoxGeometry, Group, Mesh, type Object3D } from "three";
import { describe, expect, it } from "vitest";

import { placeOn, type Placement } from "./framing";
import { WHOLE, focusOf } from "./gallery";

/**
 * Where a model ended up, as three plain numbers.
 *
 * Negating a zero is still a zero to everything but a strict comparison, and framing a model
 * centred on an axis negates one — so the sign is taken off before anything is compared. What
 * is being asked about here is where the body is, and there is no such place as minus nothing.
 */
const where = (model: Object3D): number[] =>
  model.position.toArray().map((axis) => (axis === 0 ? 0 : axis));

/**
 * A body of the shape the game hands over: standing on the floor rather than centred on the
 * origin, which is the whole reason a stage has to move one at all.
 */
const character = (): Group => {
  const model = new Group();
  const body = new Mesh(new BoxGeometry(0.6, 2, 0.4));
  body.position.set(0, 1, 0);
  model.add(body);
  return model;
};

/** A square pane, the field of view both stages use. */
const pane = (focus = WHOLE): Placement => ({ focus, view: "default", fov: 35, aspect: 1 });

describe("placeOn", () => {
  it("puts the part being looked at on the origin", () => {
    const model = character();
    placeOn(model, pane());
    // Half way up a body that stood from 0 to 2, so the middle of her is now the middle of the
    // picture — which is the point the camera orbits and the point a zoom goes towards.
    expect(where(model)).toEqual([0, -1, 0]);
  });

  it("frames a head on the head rather than on the middle of the body", () => {
    const model = character();
    placeOn(model, pane(focusOf(0, "worn")));
    // 0.92 of the way up her, which is where `gallery.ts` says a helm is.
    expect(model.position.y).toBeCloseTo(-1.84, 5);
  });

  /**
   * The bug this module exists for, and it is not a subtle one on screen.
   *
   * A thumbnail is repainted once per pointer move while the reader turns it, and a repaint
   * frames the model that is already on the graphics card — the same object, still standing
   * where the last framing put it. Measuring it where it stands rather than as it is means the
   * offset is computed against an already-offset body: the second paint takes it back off the
   * origin, the third puts it back, and what the reader sees is a set flickering up and down
   * for as long as they drag it.
   *
   * So framing has to answer the same thing every time it is asked, and the test for that is
   * simply to ask it more than once.
   */
  it("frames a model the same way however many times it is framed", () => {
    const model = character();
    const first = placeOn(model, pane());
    const settled = where(model);

    for (let again = 0; again < 4; again += 1) {
      const repeat = placeOn(model, pane());
      expect(where(model)).toEqual(settled);
      expect(repeat.distance).toBeCloseTo(first.distance, 10);
    }
  });

  it("frames a slot the same way however many times it is framed", () => {
    const model = character();
    const boots = focusOf(6, "worn");
    const first = placeOn(model, pane(boots));
    const settled = where(model);

    const repeat = placeOn(model, pane(boots));
    expect(where(model)).toEqual(settled);
    expect(repeat.distance).toBeCloseTo(first.distance, 10);
  });
});
