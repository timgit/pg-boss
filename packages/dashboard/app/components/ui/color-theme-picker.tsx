import { Menu } from '@base-ui/react/menu'
import { useTheme, COLOR_THEMES, type ColorTheme } from '~/components/theme-provider'
import { cn } from '~/lib/utils'

// Map color names to their Tailwind CSS variable for the 500 shade
const colorSwatchStyles: Record<ColorTheme, string> = {
  cobalt: 'bg-[#3b66f5]',
  emerald: 'bg-emerald-500',
  teal: 'bg-teal-500',
  cyan: 'bg-cyan-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  purple: 'bg-purple-500',
}

const colorLabels: Record<ColorTheme, string> = {
  cobalt: 'Cobalt',
  emerald: 'Emerald',
  teal: 'Teal',
  cyan: 'Cyan',
  sky: 'Sky',
  blue: 'Blue',
  indigo: 'Indigo',
  violet: 'Violet',
  purple: 'Purple',
}

/**
 * The accent palette, opened by whatever is passed in as `children`.
 *
 * It has no control of its own any more. It used to be a labelled row in the
 * sidebar footer — a swatch, the word "Violet", and a menu — which gave a
 * decoration the same standing in the navigation as the pages. The colour is
 * something somebody sets once, so it now hangs off the mark in the sidebar
 * header: the trigger is the logo, the only hint is the pointer cursor, and
 * nothing announces it. Deliberately undiscoverable rather than accidentally
 * so.
 *
 * `children` is the trigger's content, so the caller keeps ownership of what
 * the mark looks like and this keeps ownership of what opening it does.
 * `aria-label` stays: an unlabelled button that changes the product's colours
 * is a worse experience for somebody on a screen reader than an easter egg is
 * a good one for everybody else, and "hidden" here means unadvertised, not
 * inaccessible.
 */
export function ColorThemePicker ({ children }: { children: React.ReactNode }) {
  const { colorTheme, setColorTheme } = useTheme()

  return (
    <Menu.Root>
      {/*
        No transform on hover, and that is not a taste call. The popup is placed
        from the trigger's bounding rect, and a transform changes that rect even
        though it changes no layout — so growing the mark by 4% while the cursor
        sat on it moved the menu down by the difference and snapped it back when
        the pointer left. Opacity is the hover state that a positioned popup can
        live with.
      */}
      <Menu.Trigger
        className={cn(
          'flex items-center rounded-md cursor-pointer',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-600',
          'transition-opacity hover:opacity-80'
        )}
        aria-label="Change color theme"
      >
        {children}
      </Menu.Trigger>

      <Menu.Portal container={typeof document !== 'undefined' ? document.body : undefined}>
        {/*
          Left edges together, not centres. The default is `align="center"`,
          which centres a ~190px popup on a 32px mark and so hangs most of it
          off to the left, past the sidebar's own padding. `start` puts the
          popup's left edge on the mark's, which is the line everything else in
          the sidebar is already on.
        */}
        <Menu.Positioner className="z-[100]" align="start" sideOffset={8}>
          <Menu.Popup
            className={cn(
              // Roomier than a menu of text rows, because this is not one: the
              // swatches are targets with a ring that sits outside them, and at
              // p-2 the selected one's ring touched the popup's own border.
              'rounded-lg border p-3.5 shadow-md z-[100]',
              'bg-white border-gray-200',
              'dark:bg-gray-900 dark:border-gray-800',
              'animate-in fade-in-0 zoom-in-95'
            )}
          >
            {/*
              The popup says what it is. Nothing else does any more — the
              trigger is the mark and carries no label — so without this the
              first time somebody finds it they get a grid of coloured shapes
              and no word for what pressing one changes.
            */}
            <div className="pb-3 text-xs font-medium text-gray-500 dark:text-gray-400">
              Theme
            </div>
            {/*
              Three across, because there are nine: four across left a row of
              four, a row of four and an orphan, which reads as a palette that
              lost one. If COLOR_THEMES ever stops being a square number this
              has to be looked at again — a grid is only tidy when the count
              agrees with it.
            */}
            <div className="grid grid-cols-3 gap-2.5">
              {COLOR_THEMES.map((color) => (
                <Menu.Item
                  key={color}
                  className={cn(
                    // The mark's own proportions — 8.3875 by 9.394, a shade
                    // taller than wide — rather than a circle. The dots in the
                    // logo are this shape, and a grid of circles beside it is
                    // the one place the console drew the brand's shape wrong.
                    'w-[25px] h-[28px] rounded-[50%] cursor-pointer transition-all',
                    'outline-none',
                    'hover:scale-110',
                    colorSwatchStyles[color],
                    colorTheme === color && 'ring-2 ring-offset-2 ring-gray-900 dark:ring-white dark:ring-offset-gray-900'
                  )}
                  onClick={() => setColorTheme(color)}
                  aria-label={color}
                  title={colorLabels[color]}
                />
              ))}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
