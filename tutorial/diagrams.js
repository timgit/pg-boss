/* Inline SVG diagrams. Colours come from the CSS classes in styles.css so every diagram
   follows the viewer's light/dark theme; marker ids are per-diagram to avoid collisions. */
(function (global) {
  const PGB = global.PGB = global.PGB || {}

  const arrow = (id, cls) =>
    `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" class="${cls}"/></marker></defs>`

  const DIAGRAMS = {}

  /* ---------- 1. the core bet ---------- */
  DIAGRAMS['core-bet'] = `
<svg viewBox="0 0 640 280" role="img" aria-label="Producers insert rows, workers claim them with SKIP LOCKED">
  ${arrow('cb-a', 'd-arrow')}${arrow('cb-b', 'd-arrow-accent')}
  <rect x="8" y="96" width="112" height="52" rx="7" class="d-box"/>
  <text x="64" y="118" text-anchor="middle" class="d-mono">send()</text>
  <text x="64" y="134" text-anchor="middle" class="d-label-sm">your app</text>

  <path d="M124 122 H176" class="d-line" stroke-width="1.5" marker-end="url(#cb-a)"/>
  <text x="150" y="112" text-anchor="middle" class="d-label-sm">INSERT</text>

  <rect x="184" y="42" width="176" height="196" rx="7" class="d-box-accent"/>
  <text x="272" y="64" text-anchor="middle" class="d-mono">pgboss.job</text>
  <line x1="184" y1="74" x2="360" y2="74" class="d-line"/>

  <rect x="198" y="86" width="148" height="24" rx="4" class="d-box"/>
  <text x="208" y="102" class="d-mono-sm">created &#183; priority 5</text>
  <rect x="198" y="116" width="148" height="24" rx="4" class="d-box"/>
  <text x="208" y="132" class="d-mono-sm">created &#183; priority 0</text>
  <rect x="198" y="146" width="148" height="24" rx="4" class="d-box"/>
  <text x="208" y="162" class="d-mono-sm">created &#183; priority 0</text>
  <rect x="198" y="176" width="148" height="24" rx="4" class="d-box"/>
  <text x="208" y="192" class="d-mono-sm">active &#183; locked</text>
  <text x="272" y="222" text-anchor="middle" class="d-label-sm">one table, one lock protocol</text>

  <path d="M366 98 H424" class="d-line-accent" stroke-width="1.5" marker-end="url(#cb-b)"/>
  <path d="M366 128 H424" class="d-line-accent" stroke-width="1.5" marker-end="url(#cb-b)"/>
  <path d="M366 158 H424" class="d-line-accent" stroke-width="1.5" marker-end="url(#cb-b)"/>
  <text x="396" y="88" text-anchor="middle" class="d-label-sm">SKIP LOCKED</text>

  <rect x="430" y="82" width="120" height="32" rx="6" class="d-box"/>
  <text x="490" y="103" text-anchor="middle" class="d-mono-sm">worker A</text>
  <rect x="430" y="112" width="120" height="32" rx="6" class="d-box"/>
  <text x="490" y="133" text-anchor="middle" class="d-mono-sm">worker B</text>
  <rect x="430" y="142" width="120" height="32" rx="6" class="d-box"/>
  <text x="490" y="163" text-anchor="middle" class="d-mono-sm">worker C</text>

  <text x="562" y="128" class="d-label-sm">any host,</text>
  <text x="562" y="143" class="d-label-sm">any process</text>

  <text x="320" y="264" text-anchor="middle" class="d-label">No broker. Postgres is the queue, and its lock manager is the delivery guarantee.</text>
</svg>`

  /* ---------- 2. component composition ---------- */
  DIAGRAMS.composition = `
<svg viewBox="0 0 640 320" role="img" aria-label="PgBoss composes seven collaborators over one IDatabase">
  ${arrow('cp-a', 'd-arrow')}
  <rect x="150" y="10" width="340" height="46" rx="7" class="d-box-accent"/>
  <text x="320" y="32" text-anchor="middle" class="d-mono">PgBoss extends EventEmitter</text>
  <text x="320" y="48" text-anchor="middle" class="d-label-sm">src/index.ts &#183; delegates, does no work</text>

  <path d="M320 58 V78" class="d-line" stroke-width="1.5"/>
  <path d="M60 78 H580" class="d-line" stroke-width="1.5"/>

  <g class="d-box">
    <rect x="14" y="96" width="88" height="54" rx="6"/>
    <rect x="110" y="96" width="88" height="54" rx="6"/>
    <rect x="206" y="96" width="88" height="54" rx="6"/>
    <rect x="302" y="96" width="88" height="54" rx="6"/>
    <rect x="398" y="96" width="88" height="54" rx="6"/>
    <rect x="494" y="96" width="88" height="54" rx="6"/>
    <rect x="590" y="96" width="36" height="54" rx="6"/>
  </g>
  <path d="M58 78 V96 M154 78 V96 M250 78 V96 M346 78 V96 M442 78 V96 M538 78 V96 M608 78 V96" class="d-line" stroke-width="1.5"/>

  <text x="58" y="118" text-anchor="middle" class="d-mono-sm">Contractor</text>
  <text x="58" y="134" text-anchor="middle" class="d-label-sm">schema</text>
  <text x="154" y="118" text-anchor="middle" class="d-mono-sm">Manager</text>
  <text x="154" y="134" text-anchor="middle" class="d-label-sm">jobs</text>
  <text x="250" y="118" text-anchor="middle" class="d-mono-sm">Boss</text>
  <text x="250" y="134" text-anchor="middle" class="d-label-sm">supervise</text>
  <text x="346" y="118" text-anchor="middle" class="d-mono-sm">Timekeeper</text>
  <text x="346" y="134" text-anchor="middle" class="d-label-sm">cron</text>
  <text x="442" y="118" text-anchor="middle" class="d-mono-sm">Navigator</text>
  <text x="442" y="134" text-anchor="middle" class="d-label-sm">flows</text>
  <text x="538" y="118" text-anchor="middle" class="d-mono-sm">Notifier</text>
  <text x="538" y="134" text-anchor="middle" class="d-label-sm">LISTEN</text>
  <text x="608" y="118" text-anchor="middle" class="d-mono-sm">Bam</text>
  <text x="608" y="134" text-anchor="middle" class="d-label-sm">DDL</text>

  <path d="M58 150 V182 M154 150 V182 M250 150 V182 M346 150 V182 M442 150 V182 M538 150 V182 M608 150 V182" class="d-line" stroke-width="1.5"/>
  <path d="M58 182 H608" class="d-line" stroke-width="1.5"/>
  <path d="M320 182 V206" class="d-line" stroke-width="1.5" marker-end="url(#cp-a)"/>

  <rect x="180" y="212" width="280" height="46" rx="7" class="d-box-accent"/>
  <text x="320" y="234" text-anchor="middle" class="d-mono">one IDatabase</text>
  <text x="320" y="250" text-anchor="middle" class="d-label-sm">+ one resolved config, shared by all seven</text>

  <text x="320" y="288" text-anchor="middle" class="d-label-sm">Each collaborator is itself an EventEmitter with an <tspan class="d-mono-sm">events</tspan> map;</text>
  <text x="320" y="304" text-anchor="middle" class="d-label-sm"><tspan class="d-mono-sm">#promoteEvents</tspan> re-emits every one of them on the PgBoss instance.</text>
</svg>`

  /* ---------- 3. job state machine ---------- */
  DIAGRAMS['job-states'] = `
<svg viewBox="0 0 640 330" role="img" aria-label="The job state machine and the plan that owns each transition">
  ${arrow('js-a', 'd-arrow')}${arrow('js-b', 'd-arrow-accent')}
  <rect x="14" y="120" width="104" height="40" rx="20" class="d-box-accent"/>
  <text x="66" y="139" text-anchor="middle" class="d-mono">created</text>
  <text x="66" y="153" text-anchor="middle" class="d-mono-sm">0</text>

  <rect x="176" y="120" width="104" height="40" rx="20" class="d-box-accent"/>
  <text x="228" y="139" text-anchor="middle" class="d-mono">active</text>
  <text x="228" y="153" text-anchor="middle" class="d-mono-sm">2</text>

  <rect x="176" y="34" width="104" height="40" rx="20" class="d-box"/>
  <text x="228" y="53" text-anchor="middle" class="d-mono">retry</text>
  <text x="228" y="67" text-anchor="middle" class="d-mono-sm">1</text>

  <rect x="360" y="52" width="112" height="40" rx="20" class="d-box"/>
  <text x="416" y="71" text-anchor="middle" class="d-mono">completed</text>
  <text x="416" y="85" text-anchor="middle" class="d-mono-sm">3</text>

  <rect x="360" y="196" width="112" height="40" rx="20" class="d-box"/>
  <text x="416" y="215" text-anchor="middle" class="d-mono">cancelled</text>
  <text x="416" y="229" text-anchor="middle" class="d-mono-sm">4</text>

  <rect x="360" y="124" width="112" height="40" rx="20" class="d-box"/>
  <text x="416" y="143" text-anchor="middle" class="d-mono">failed</text>
  <text x="416" y="157" text-anchor="middle" class="d-mono-sm">5</text>

  <path d="M120 140 H172" class="d-line-accent" stroke-width="1.5" marker-end="url(#js-b)"/>
  <text x="146" y="132" text-anchor="middle" class="d-mono-sm">fetch</text>

  <path d="M282 132 L356 84" class="d-line" stroke-width="1.5" marker-end="url(#js-a)"/>
  <text x="326" y="102" text-anchor="middle" class="d-mono-sm">complete</text>

  <path d="M282 148 L356 144" class="d-line" stroke-width="1.5" marker-end="url(#js-a)"/>
  <text x="322" y="166" text-anchor="middle" class="d-mono-sm">fail (last try)</text>

  <path d="M228 116 V78" class="d-line" stroke-width="1.5" marker-end="url(#js-a)"/>
  <text x="244" y="100" class="d-mono-sm">fail (retries left)</text>

  <path d="M176 54 H130 Q112 54 112 74 V116" class="d-line" stroke-width="1.5" marker-end="url(#js-a)"/>
  <text x="106" y="98" text-anchor="end" class="d-mono-sm">fetch</text>

  <path d="M66 164 V214 H356" class="d-line" stroke-width="1.5" marker-end="url(#js-a)"/>
  <text x="180" y="230" text-anchor="middle" class="d-mono-sm">cancel</text>

  <path d="M416 192 V176" class="d-line" stroke-width="1.5" marker-end="url(#js-a)"/>
  <text x="480" y="188" text-anchor="middle" class="d-mono-sm">retry() re-arms</text>

  <path d="M360 216 H316 Q296 216 296 250 H100 Q66 250 66 200 V164" class="d-line" stroke-width="1.5" marker-end="url(#js-a)"/>
  <text x="196" y="266" text-anchor="middle" class="d-mono-sm">resume</text>

  <text x="320" y="296" text-anchor="middle" class="d-label">The numbers are the ENUM ordinals — and they are load-bearing.</text>
  <text x="320" y="314" text-anchor="middle" class="d-label-sm">Predicates are comparisons: <tspan class="d-mono-sm">state &lt; 'active'</tspan> means "created or retry".</text>
</svg>`

  /* ---------- 4. partitioning ---------- */
  DIAGRAMS.partitioning = `
<svg viewBox="0 0 640 300" role="img" aria-label="The job table is partitioned by list on queue name">
  ${arrow('pt-a', 'd-arrow')}
  <rect x="180" y="14" width="280" height="50" rx="7" class="d-box-accent"/>
  <text x="320" y="36" text-anchor="middle" class="d-mono">pgboss.job</text>
  <text x="320" y="52" text-anchor="middle" class="d-label-sm">PARTITION BY LIST (name) &#183; logical, holds no rows</text>

  <path d="M320 64 V88" class="d-line" stroke-width="1.5"/>
  <path d="M100 88 H540" class="d-line" stroke-width="1.5"/>
  <path d="M100 88 V112 M320 88 V112 M540 88 V112" class="d-line" stroke-width="1.5" marker-end="url(#pt-a)"/>

  <rect x="20" y="118" width="160" height="66" rx="7" class="d-box"/>
  <text x="100" y="140" text-anchor="middle" class="d-mono-sm">job_common</text>
  <text x="100" y="157" text-anchor="middle" class="d-label-sm">DEFAULT partition</text>
  <text x="100" y="172" text-anchor="middle" class="d-label-sm">every ordinary queue</text>

  <rect x="240" y="118" width="160" height="66" rx="7" class="d-box"/>
  <text x="320" y="140" text-anchor="middle" class="d-mono-sm">j3f8c1&#8230;</text>
  <text x="320" y="157" text-anchor="middle" class="d-label-sm">FOR VALUES IN ('email')</text>
  <text x="320" y="172" text-anchor="middle" class="d-label-sm">partition: true</text>

  <rect x="460" y="118" width="160" height="66" rx="7" class="d-box"/>
  <text x="540" y="140" text-anchor="middle" class="d-mono-sm">j91ae7&#8230;</text>
  <text x="540" y="157" text-anchor="middle" class="d-label-sm">FOR VALUES IN ('video')</text>
  <text x="540" y="172" text-anchor="middle" class="d-label-sm">partition: true</text>

  <rect x="120" y="212" width="400" height="46" rx="7" class="d-box-accent"/>
  <text x="320" y="232" text-anchor="middle" class="d-mono-sm">queue.table_name</text>
  <text x="320" y="248" text-anchor="middle" class="d-label-sm">the routing column &#183; cached by Manager.getQueueCache</text>

  <text x="320" y="284" text-anchor="middle" class="d-label-sm">DDL fans out over every physical table via the <tspan class="d-mono-sm">job_table_run</tspan> plpgsql helpers.</text>
</svg>`

  /* ---------- 5. the fetch race ---------- */
  DIAGRAMS['fetch-race'] = `
<svg viewBox="0 0 640 300" role="img" aria-label="Two workers running the same fetch query claim disjoint rows">
  ${arrow('fr-a', 'd-arrow-accent')}${arrow('fr-b', 'd-arrow')}
  <text x="150" y="24" text-anchor="middle" class="d-mono-sm">worker A</text>
  <text x="490" y="24" text-anchor="middle" class="d-mono-sm">worker B</text>
  <text x="320" y="24" text-anchor="middle" class="d-label-sm">same query, same instant</text>

  <rect x="248" y="42" width="144" height="184" rx="7" class="d-box-accent"/>
  <text x="320" y="62" text-anchor="middle" class="d-mono-sm">eligible rows</text>
  <line x1="248" y1="72" x2="392" y2="72" class="d-line"/>

  <rect x="260" y="82" width="120" height="26" rx="4" class="d-box"/>
  <text x="320" y="99" text-anchor="middle" class="d-mono-sm">job 1</text>
  <rect x="260" y="114" width="120" height="26" rx="4" class="d-box"/>
  <text x="320" y="131" text-anchor="middle" class="d-mono-sm">job 2</text>
  <rect x="260" y="146" width="120" height="26" rx="4" class="d-box"/>
  <text x="320" y="163" text-anchor="middle" class="d-mono-sm">job 3</text>
  <rect x="260" y="178" width="120" height="26" rx="4" class="d-box"/>
  <text x="320" y="195" text-anchor="middle" class="d-mono-sm">job 4</text>

  <path d="M170 95 H256" class="d-line-accent" stroke-width="1.5" marker-end="url(#fr-a)"/>
  <text x="212" y="88" text-anchor="middle" class="d-label-sm d-good">locks</text>
  <path d="M170 127 H256" class="d-line" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#fr-b)"/>

  <path d="M470 127 H388" class="d-line-accent" stroke-width="1.5" marker-end="url(#fr-a)"/>
  <text x="428" y="120" text-anchor="middle" class="d-label-sm d-good">locks</text>
  <path d="M470 95 H388" class="d-line" stroke-width="1.2" stroke-dasharray="3 3" marker-end="url(#fr-b)"/>
  <text x="500" y="99" class="d-label-sm">skipped, not blocked</text>

  <text x="320" y="252" text-anchor="middle" class="d-label">Without <tspan class="d-mono-sm">SKIP LOCKED</tspan>, B would wait on A's row and the queue would serialise.</text>
  <text x="320" y="272" text-anchor="middle" class="d-label-sm">With it, B's scan steps over the locked row and takes the next one — no coordination, no retry loop.</text>
</svg>`

  /* ---------- 6. flow DAG ---------- */
  DIAGRAMS['flow-dag'] = `
<svg viewBox="0 0 640 300" role="img" aria-label="A flow DAG using blocked, blocking and pending_dependencies">
  ${arrow('fd-a', 'd-arrow')}
  <rect x="30" y="60" width="130" height="56" rx="7" class="d-box-accent"/>
  <text x="95" y="82" text-anchor="middle" class="d-mono-sm">extract</text>
  <text x="95" y="98" text-anchor="middle" class="d-label-sm">blocking = true</text>

  <rect x="30" y="150" width="130" height="56" rx="7" class="d-box-accent"/>
  <text x="95" y="172" text-anchor="middle" class="d-mono-sm">fetch-assets</text>
  <text x="95" y="188" text-anchor="middle" class="d-label-sm">blocking = true</text>

  <rect x="250" y="105" width="140" height="70" rx="7" class="d-box"/>
  <text x="320" y="128" text-anchor="middle" class="d-mono-sm">transform</text>
  <text x="320" y="145" text-anchor="middle" class="d-label-sm">blocked = true</text>
  <text x="320" y="161" text-anchor="middle" class="d-mono-sm">pending_dependencies 2</text>

  <rect x="470" y="105" width="140" height="70" rx="7" class="d-box"/>
  <text x="540" y="128" text-anchor="middle" class="d-mono-sm">publish</text>
  <text x="540" y="145" text-anchor="middle" class="d-label-sm">blocked = true</text>
  <text x="540" y="161" text-anchor="middle" class="d-mono-sm">pending_dependencies 1</text>

  <path d="M164 92 Q210 92 246 122" class="d-line" stroke-width="1.5" marker-end="url(#fd-a)"/>
  <path d="M164 176 Q210 176 246 158" class="d-line" stroke-width="1.5" marker-end="url(#fd-a)"/>
  <path d="M394 140 H466" class="d-line" stroke-width="1.5" marker-end="url(#fd-a)"/>

  <text x="320" y="220" text-anchor="middle" class="d-label-sm">The fetch index excludes blocked rows outright: <tspan class="d-mono-sm">WHERE state &lt; 'active' AND NOT blocked</tspan></text>
  <text x="320" y="248" text-anchor="middle" class="d-label">Completion never touches this graph.</text>
  <text x="320" y="268" text-anchor="middle" class="d-label-sm">Navigator audits completed <tspan class="d-mono-sm">blocking</tspan> parents out of band and decrements the counters,</text>
  <text x="320" y="284" text-anchor="middle" class="d-label-sm">so <tspan class="d-mono-sm">complete()</tspan> stays a single join-free UPDATE.</text>
</svg>`

  /* ---------- 7. what fail() does ---------- */
  DIAGRAMS['fail-paths'] = `
<svg viewBox="0 0 640 300" role="img" aria-label="fail deletes the row and re-inserts it as retry or failed, plus a dead letter copy">
  ${arrow('fp-a', 'd-arrow')}${arrow('fp-b', 'd-arrow-accent')}
  <rect x="16" y="118" width="130" height="52" rx="7" class="d-box-accent"/>
  <text x="81" y="140" text-anchor="middle" class="d-mono-sm">active row</text>
  <text x="81" y="156" text-anchor="middle" class="d-label-sm">handler threw</text>

  <path d="M150 144 H208" class="d-line-accent" stroke-width="1.5" marker-end="url(#fp-b)"/>
  <text x="179" y="136" text-anchor="middle" class="d-mono-sm">DELETE</text>

  <rect x="212" y="112" width="120" height="64" rx="7" class="d-box"/>
  <text x="272" y="134" text-anchor="middle" class="d-mono-sm">deleted_jobs</text>
  <text x="272" y="150" text-anchor="middle" class="d-label-sm">CTE holds the</text>
  <text x="272" y="164" text-anchor="middle" class="d-label-sm">whole row</text>

  <path d="M336 128 Q370 128 396 76" class="d-line" stroke-width="1.5" marker-end="url(#fp-a)"/>
  <path d="M336 160 Q370 160 396 200" class="d-line" stroke-width="1.5" marker-end="url(#fp-a)"/>

  <rect x="400" y="42" width="164" height="60" rx="7" class="d-box"/>
  <text x="482" y="64" text-anchor="middle" class="d-mono-sm">INSERT &#8594; retry</text>
  <text x="482" y="80" text-anchor="middle" class="d-label-sm">retry_count &lt; retry_limit</text>
  <text x="482" y="94" text-anchor="middle" class="d-label-sm">start_after = jittered backoff</text>

  <rect x="400" y="182" width="164" height="60" rx="7" class="d-box"/>
  <text x="482" y="204" text-anchor="middle" class="d-mono-sm">INSERT &#8594; failed</text>
  <text x="482" y="220" text-anchor="middle" class="d-label-sm">retries exhausted</text>
  <text x="482" y="234" text-anchor="middle" class="d-label-sm">or forced terminal</text>

  <path d="M566 212 Q600 212 600 258 H320" class="d-line" stroke-width="1.5" marker-end="url(#fp-a)"/>
  <text x="440" y="274" text-anchor="middle" class="d-label-sm">and, if the queue has one, a fresh <tspan class="d-mono-sm">created</tspan> job on the dead-letter queue</text>

  <text x="82" y="204" text-anchor="middle" class="d-label-sm">Why not UPDATE?</text>
  <text x="82" y="220" text-anchor="middle" class="d-label-sm">The policy indexes</text>
  <text x="82" y="234" text-anchor="middle" class="d-label-sm">key on state, so the</text>
  <text x="82" y="248" text-anchor="middle" class="d-label-sm">re-INSERT is what</text>
  <text x="82" y="262" text-anchor="middle" class="d-label-sm">re-checks policy.</text>
</svg>`

  /* ---------- 8. the supervise loop ---------- */
  DIAGRAMS['supervise-loop'] = `
<svg viewBox="0 0 640 300" role="img" aria-label="The supervisor timer drives monitor and maintain per queue table">
  ${arrow('sl-a', 'd-arrow')}${arrow('sl-b', 'd-arrow-accent')}
  <rect x="16" y="118" width="126" height="58" rx="7" class="d-box-accent"/>
  <text x="79" y="140" text-anchor="middle" class="d-mono-sm">setInterval</text>
  <text x="79" y="156" text-anchor="middle" class="d-label-sm">superviseInterval</text>
  <text x="79" y="170" text-anchor="middle" class="d-label-sm">Seconds</text>

  <path d="M146 147 H196" class="d-line-accent" stroke-width="1.5" marker-end="url(#sl-b)"/>

  <rect x="200" y="112" width="128" height="70" rx="7" class="d-box"/>
  <text x="264" y="134" text-anchor="middle" class="d-mono-sm">claim the tick</text>
  <text x="264" y="151" text-anchor="middle" class="d-label-sm">conditional UPDATE</text>
  <text x="264" y="166" text-anchor="middle" class="d-mono-sm">RETURNING true</text>

  <path d="M332 128 Q364 128 390 82" class="d-line" stroke-width="1.5" marker-end="url(#sl-a)"/>
  <path d="M332 166 Q364 166 390 212" class="d-line" stroke-width="1.5" marker-end="url(#sl-a)"/>

  <rect x="394" y="40" width="212" height="80" rx="7" class="d-box"/>
  <text x="500" y="62" text-anchor="middle" class="d-mono-sm">#monitor</text>
  <text x="500" y="80" text-anchor="middle" class="d-label-sm">cache queue counters</text>
  <text x="500" y="95" text-anchor="middle" class="d-label-sm">warn on backlog</text>
  <text x="500" y="110" text-anchor="middle" class="d-label-sm">fail expired / heartbeat-stale jobs</text>

  <rect x="394" y="174" width="212" height="80" rx="7" class="d-box"/>
  <text x="500" y="196" text-anchor="middle" class="d-mono-sm">#maintain</text>
  <text x="500" y="214" text-anchor="middle" class="d-label-sm">delete jobs past retention</text>
  <text x="500" y="229" text-anchor="middle" class="d-label-sm">roll queue_stats partitions</text>
  <text x="500" y="244" text-anchor="middle" class="d-label-sm">clean orphan dependency rows</text>

  <text x="320" y="284" text-anchor="middle" class="d-label-sm">Queues are grouped by physical table and chunked 100 at a time, with a stop check between every step.</text>
</svg>`

  /* ---------- 9. the BAM timeline ---------- */
  DIAGRAMS['bam-timeline'] = `
<svg viewBox="0 0 640 290" role="img" aria-label="Async DDL is enqueued during migration and applied later by the BAM worker">
  ${arrow('bt-a', 'd-arrow')}${arrow('bt-b', 'd-arrow-accent')}
  <line x1="24" y1="150" x2="616" y2="150" class="d-line" stroke-width="1.5"/>

  <circle cx="90" cy="150" r="6" class="d-box-accent"/>
  <circle cx="300" cy="150" r="6" class="d-box-accent"/>
  <circle cx="500" cy="150" r="6" class="d-box-accent"/>

  <text x="90" y="176" text-anchor="middle" class="d-mono-sm">start()</text>
  <text x="300" y="176" text-anchor="middle" class="d-mono-sm">start() returns</text>
  <text x="500" y="176" text-anchor="middle" class="d-mono-sm">bam tick</text>

  <rect x="14" y="60" width="156" height="72" rx="7" class="d-box"/>
  <text x="92" y="82" text-anchor="middle" class="d-mono-sm">migration txn</text>
  <text x="92" y="99" text-anchor="middle" class="d-label-sm">fast DDL runs inline</text>
  <text x="92" y="114" text-anchor="middle" class="d-label-sm">slow DDL is enqueued</text>
  <text x="92" y="128" text-anchor="middle" class="d-mono-sm">job_table_run_async</text>
  <path d="M92 132 V144" class="d-line" stroke-width="1.5" marker-end="url(#bt-a)"/>

  <rect x="214" y="196" width="180" height="66" rx="7" class="d-box-accent"/>
  <text x="304" y="218" text-anchor="middle" class="d-mono-sm">pgboss.bam</text>
  <text x="304" y="234" text-anchor="middle" class="d-label-sm">one pending row per</text>
  <text x="304" y="249" text-anchor="middle" class="d-label-sm">physical job table</text>
  <path d="M120 132 Q200 132 240 192" class="d-line" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#bt-a)"/>

  <rect x="430" y="46" width="196" height="86" rx="7" class="d-box"/>
  <text x="528" y="68" text-anchor="middle" class="d-mono-sm">CREATE INDEX</text>
  <text x="528" y="84" text-anchor="middle" class="d-mono-sm">CONCURRENTLY</text>
  <text x="528" y="101" text-anchor="middle" class="d-label-sm">outside any transaction</text>
  <text x="528" y="116" text-anchor="middle" class="d-label-sm">minutes or hours, safely</text>
  <path d="M394 220 Q500 220 500 144" class="d-line-accent" stroke-width="1.5" marker-end="url(#bt-b)"/>

  <text x="300" y="30" text-anchor="middle" class="d-label">Your app is already serving jobs here &#8212;</text>
  <text x="300" y="46" text-anchor="middle" class="d-label-sm">nothing about the slow build is on the startup path.</text>
</svg>`

  PGB.DIAGRAMS = DIAGRAMS
})(window)
