import { useSearchParams } from 'react-router'
import { STATS_INTERVALS, type StatsInterval } from '~/lib/stats'
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group'

// The 1h / 6h / 24h switch on the /stats pages, kept in the URL as ?interval=.
export function StatsIntervalSwitch ({ interval }: { interval: StatsInterval }) {
  const [searchParams, setSearchParams] = useSearchParams()

  const change = (next: StatsInterval) => {
    const params = new URLSearchParams(searchParams)
    params.set('interval', next)
    setSearchParams(params, { preventScrollReset: true })
  }

  return (
    <ToggleGroup
      aria-label="Interval"
      value={[interval]}
      onValueChange={(value) => { if (value[0]) change(value[0] as StatsInterval) }}
    >
      {Object.keys(STATS_INTERVALS).map((key) => (
        <ToggleGroupItem key={key} value={key}>{key}</ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
