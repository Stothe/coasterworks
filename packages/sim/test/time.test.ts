import { describe, expect, it } from "vitest";
import {
  DAYS_PER_MONTH,
  MONTHS_PER_YEAR,
  MONTH_NAMES,
  TICKS_PER_DAY,
  TICKS_PER_SECOND,
  dateOf,
  formatDate,
  isMonthStart,
} from "../src/index.js";

const TICKS_PER_MONTH = TICKS_PER_DAY * DAYS_PER_MONTH;
const TICKS_PER_YEAR = TICKS_PER_MONTH * MONTHS_PER_YEAR;

describe("calendar constants", () => {
  it("has 40 ticks a second, 400 a day, 31 days a month, 8 months a year", () => {
    expect(TICKS_PER_SECOND).toBe(40);
    expect(TICKS_PER_DAY).toBe(400);
    expect(DAYS_PER_MONTH).toBe(31);
    expect(MONTHS_PER_YEAR).toBe(8);
    expect(MONTH_NAMES).toEqual([
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
    ]);
    expect(MONTH_NAMES).toHaveLength(MONTHS_PER_YEAR);
  });
});

describe("dateOf", () => {
  it("starts at March 1, Year 1", () => {
    expect(dateOf(0)).toEqual({ year: 1, month: 0, day: 1, tickOfDay: 0 });
  });

  it("moves to month 1 day 1 after 31 days", () => {
    expect(dateOf(TICKS_PER_DAY * 31)).toEqual({ year: 1, month: 1, day: 1, tickOfDay: 0 });
  });

  it("moves to year 2 month 0 after 8 months", () => {
    expect(dateOf(TICKS_PER_DAY * 31 * 8)).toEqual({ year: 2, month: 0, day: 1, tickOfDay: 0 });
  });

  it("counts ticks within a day and days within a month", () => {
    expect(dateOf(399)).toEqual({ year: 1, month: 0, day: 1, tickOfDay: 399 });
    expect(dateOf(400)).toEqual({ year: 1, month: 0, day: 2, tickOfDay: 0 });
    expect(dateOf(TICKS_PER_MONTH - 1)).toEqual({ year: 1, month: 0, day: 31, tickOfDay: 399 });
  });

  it("ends the year on October 31", () => {
    expect(dateOf(TICKS_PER_YEAR - 1)).toEqual({ year: 1, month: 7, day: 31, tickOfDay: 399 });
    expect(dateOf(TICKS_PER_YEAR * 2 + TICKS_PER_MONTH * 3 + TICKS_PER_DAY * 4 + 5)).toEqual({
      year: 3,
      month: 3,
      day: 5,
      tickOfDay: 5,
    });
  });

  it("rejects a tick that is negative or not an integer", () => {
    expect(() => dateOf(-1)).toThrow(RangeError);
    expect(() => dateOf(1.5)).toThrow(RangeError);
    expect(() => dateOf(Number.NaN)).toThrow(RangeError);
  });
});

describe("formatDate", () => {
  it("formats the first day as March 1, Year 1", () => {
    expect(formatDate(dateOf(0))).toBe("March 1, Year 1");
  });

  it("formats later dates", () => {
    expect(formatDate(dateOf(TICKS_PER_MONTH))).toBe("April 1, Year 1");
    expect(formatDate(dateOf(TICKS_PER_YEAR - 1))).toBe("October 31, Year 1");
    expect(formatDate(dateOf(TICKS_PER_YEAR + TICKS_PER_DAY))).toBe("March 2, Year 2");
  });
});

describe("isMonthStart", () => {
  it("is false at tick 0", () => {
    expect(isMonthStart(0)).toBe(false);
  });

  it("is true at the first tick of each later month", () => {
    expect(isMonthStart(12400)).toBe(true);
    expect(isMonthStart(12400 * 2)).toBe(true);
    // The first month of a new year is a month start too.
    expect(isMonthStart(TICKS_PER_YEAR)).toBe(true);
  });

  it("is false on every other tick", () => {
    expect(isMonthStart(1)).toBe(false);
    expect(isMonthStart(12399)).toBe(false);
    expect(isMonthStart(12401)).toBe(false);
    expect(isMonthStart(TICKS_PER_DAY)).toBe(false);
  });
});
