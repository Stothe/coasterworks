/**
 * The measures the inspector and the things beside it share, in rem. A class name cannot carry a
 * constant, so the panels that depend on them set these as inline styles.
 */

/** How far the panels at the top right sit from the window's edge: Tailwind's `right-3.5`. */
export const EDGE_GAP_REM = 0.875;

/** The inspector's width. */
export const INSPECTOR_WIDTH_REM = 20;

/** The space between the inspector and the messages that move aside for it. */
export const INSPECTOR_GAP_REM = 0.625;

/**
 * How far from the window's right edge the free space ends while the inspector is open: just left
 * of the inspector. The messages and the tray and dock keep to the space left of it.
 */
export const CLEAR_OF_INSPECTOR_REM = EDGE_GAP_REM + INSPECTOR_WIDTH_REM + INSPECTOR_GAP_REM;

/** Where the messages' right edge is while the inspector is open. */
export const TOAST_RIGHT_BESIDE_INSPECTOR_REM = CLEAR_OF_INSPECTOR_REM;
