import { Field, inputClass } from '~/components/form-field'
import { cn } from '~/lib/utils'

/** The data and options a job is sent with, shared by the send and publish forms. `parseJobFields` reads them. */
export function JobFields ({ dataHint = 'Optional. A JSON object the job carries as its data.' }: { dataHint?: string }) {
  return (
    <>
      <Field id="data" label="Data" hint={dataHint}>
        <textarea id="data" name="data" rows={6} placeholder='{"key": "value"}' className={cn(inputClass, 'font-mono')} />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="priority" label="Priority">
          <input type="number" id="priority" name="priority" placeholder="0" className={inputClass} />
        </Field>
        <Field id="startAfter" label="Start after">
          <input type="text" id="startAfter" name="startAfter" placeholder="2026-01-01T00:00:00Z, or seconds" className={inputClass} />
        </Field>
        <Field id="singletonKey" label="Singleton key">
          <input type="text" id="singletonKey" name="singletonKey" placeholder="Optional" className={inputClass} />
        </Field>
        <Field id="retryLimit" label="Retry limit">
          <input type="number" id="retryLimit" name="retryLimit" min="0" placeholder="The queue's" className={inputClass} />
        </Field>
        <Field id="expireInSeconds" label="Expire in seconds">
          <input type="number" id="expireInSeconds" name="expireInSeconds" min="1" placeholder="The queue's" className={inputClass} />
        </Field>
      </div>
    </>
  )
}
