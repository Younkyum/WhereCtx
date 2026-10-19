// @vitest-environment happy-dom
//
// The real Leaflet canvas in a DOM: which tiles it asks for, how it credits
// them, and what a scene puts on the page.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMapCanvas, type MapCanvas } from "./mapCanvas";
import type { LatLon, MapScene } from "./mapScene";

const TILES = { url: "https://tiles.example.org/osm/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors", attributionUrl: "https://www.openstreetmap.org/copyright" };

let el: HTMLElement;
let canvas: MapCanvas;
let picks: LatLon[];
let tileErrors: number;

beforeEach(() => {
  el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 400 });
  Object.defineProperty(el, "clientHeight", { value: 300 });
  document.body.appendChild(el);
  picks = [];
  tileErrors = 0;
  canvas = createMapCanvas(el, TILES, (at) => picks.push(at), () => tileErrors++);
});

afterEach(() => {
  canvas.destroy();
  el.remove();
});

const SCENE: MapScene = {
  markers: [{ id: "me", at: { lat: 37.5, lon: 127 }, title: "<img src=x onerror=alert(1)>" }],
  circles: [{ id: "place:home", at: { lat: 37.51, lon: 127.01 }, radiusM: 150, title: "home" }],
  polygons: [{ id: "place:park", ring: [{ lat: 37.52, lon: 127.02 }, { lat: 37.52, lon: 127.03 }, { lat: 37.53, lon: 127.03 }, { lat: 37.52, lon: 127.02 }], title: "park" }],
  lines: [{ id: "track", points: [{ lat: 37.5, lon: 127 }, { lat: 37.52, lon: 127.03 }] }],
};

describe("a map canvas", () => {
  it("asks the configured tile server only, with the origin alone as Referer", () => {
    const tiles = [...el.querySelectorAll("img.leaflet-tile")] as HTMLImageElement[];
    expect(tiles.length).toBeGreaterThan(0);
    for (const img of tiles) {
      expect(img.src).toMatch(/^https:\/\/tiles\.example\.org\/osm\/13\/\d+\/\d+\.png$/);
      expect(img.referrerPolicy).toBe("strict-origin");
    }
  });

  it("credits the tiles as text, linked to the attribution page", () => {
    const link = el.querySelector(".leaflet-control-attribution a") as HTMLAnchorElement;
    expect(link.textContent).toBe("© OpenStreetMap contributors");
    expect(link.href).toBe("https://www.openstreetmap.org/copyright");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("draws a scene's markers, circles, polygons and lines, and a redraw replaces them", () => {
    canvas.draw(SCENE, false);
    expect(el.querySelectorAll("path")).toHaveLength(4);
    canvas.draw({ markers: [], circles: [], polygons: [], lines: [] }, false);
    expect(el.querySelectorAll("path")).toHaveLength(0);
  });

  it("never turns a title into markup", () => {
    canvas.draw(SCENE, false);
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("reports a click as a point only while the scene is pickable", () => {
    const click = () => el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 150 }));
    canvas.draw(SCENE, false);
    click();
    expect(picks).toEqual([]);
    canvas.draw(SCENE, true);
    click();
    expect(picks).toHaveLength(1);
    expect(Math.abs(picks[0]!.lat - 37.51)).toBeLessThan(0.05);
    expect(Math.abs(picks[0]!.lon - 127.015)).toBeLessThan(0.05);
  });

  it("says once when a tile fails", () => {
    for (const img of [...el.querySelectorAll("img.leaflet-tile")].slice(0, 2)) img.dispatchEvent(new Event("error"));
    expect(tileErrors).toBe(1);
  });
});
