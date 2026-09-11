'use client';

import * as React from 'react';
import {
  VOICE_PRESET_LIST,
  resolveVoiceParams,
  type VoicePresetId,
} from '@sonder/shared';
import { ChevronDown, Cpu, Info, RotateCcw, Timer, Wand2 } from 'lucide-react';
import { Switch, Slider, OptionRow } from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/feedback';
import { useCallStore } from '@/store/call';
import { readVoiceMetrics } from '@/store/call';
import { cn } from '@/lib/utils';

/**
 * The voice-changer control surface.
 *
 * Everything here is live: moving a slider changes the audio the far end hears
 * within one parameter-smoothing window (~40 ms), because the values are pushed
 * straight through to the AudioWorklet. Nothing in this panel is decorative.
 */
export function VoiceChangerPanel({ compact = false }: { compact?: boolean }) {
  const enabled = useCallStore((state) => state.voiceChangerEnabled);
  const preset = useCallStore((state) => state.preset);
  const intensity = useCallStore((state) => state.intensity);
  const overrides = useCallStore((state) => state.overrides);
  const setEnabled = useCallStore((state) => state.setVoiceChangerEnabled);
  const setPreset = useCallStore((state) => state.setPreset);
  const setIntensity = useCallStore((state) => state.setIntensity);
  const setOverrides = useCallStore((state) => state.setOverrides);
  const resetOverrides = useCallStore((state) => state.resetOverrides);

  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [metrics, setMetrics] = React.useState(() => readVoiceMetrics());

  React.useEffect(() => {
    const timer = setInterval(() => setMetrics(readVoiceMetrics()), 1000);
    return () => clearInterval(timer);
  }, []);

  // What the engine is actually running right now, preset and intensity applied.
  const effective = resolveVoiceParams(preset, enabled ? intensity : 0, overrides);
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div className={cn('flex flex-col gap-5', compact ? 'text-sm' : '')}>
      {/* Master switch */}
      <div className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors',
              enabled ? 'bg-brand-gradient text-white' : 'bg-secondary text-muted-foreground',
            )}
          >
            <Wand2 className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold">Voice changer</span>
              <Badge variant={enabled ? 'success' : 'secondary'}>
                {enabled ? 'On' : 'Off'}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {enabled
                ? 'Your transformed voice is being sent.'
                : 'Your real voice is being sent.'}
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Voice changer"
        />
      </div>

      {/* Presets */}
      <section className="space-y-2" aria-labelledby="voice-preset-heading">
        <h3
          id="voice-preset-heading"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Preset
        </h3>
        <div role="radiogroup" aria-labelledby="voice-preset-heading" className="space-y-2">
          {VOICE_PRESET_LIST.map((option) => (
            <OptionRow
              key={option.id}
              selected={preset === option.id}
              title={option.label}
              description={option.description}
              onSelect={() => setPreset(option.id as VoicePresetId)}
              disabled={!enabled}
            />
          ))}
        </div>
      </section>

      {/* Intensity */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <label
            htmlFor="voice-intensity"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Intensity
          </label>
          <span className="tabular text-xs font-medium text-muted-foreground">
            {Math.round(intensity * 100)}%
          </span>
        </div>
        <Slider
          id="voice-intensity"
          value={[intensity]}
          onValueChange={([value]) => setIntensity(value ?? 0)}
          min={0}
          max={1}
          step={0.01}
          disabled={!enabled}
          aria-label="Voice changer intensity"
        />
        <p className="text-xs text-muted-foreground">
          Scales the whole transform. At 0% you sound like yourself; at 100% the
          preset is applied in full.
        </p>
      </section>

      {/* Advanced */}
      <section className="rounded-2xl border border-border">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-sm font-semibold"
        >
          <span>Advanced</span>
          <span className="flex items-center gap-2">
            {hasOverrides ? <Badge variant="outline">Custom</Badge> : null}
            <ChevronDown
              className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
              aria-hidden
            />
          </span>
        </button>

        {advancedOpen ? (
          <div className="space-y-4 border-t border-border px-4 py-4">
            <AdvancedSlider
              id="voice-pitch"
              label="Pitch"
              unit="st"
              value={overrides.pitchSemitones ?? effective.pitchSemitones}
              displayValue={effective.pitchSemitones}
              min={-12}
              max={12}
              step={0.5}
              disabled={!enabled}
              onChange={(value) => setOverrides({ pitchSemitones: value })}
              hint="How high the voice sits. Male-to-female usually needs +4 to +8 semitones."
            />
            <AdvancedSlider
              id="voice-formant"
              label="Formant"
              unit="x"
              value={overrides.formantRatio ?? effective.formantRatio}
              displayValue={effective.formantRatio}
              min={0.8}
              max={1.5}
              step={0.01}
              decimals={2}
              disabled={!enabled}
              onChange={(value) => setOverrides({ formantRatio: value })}
              hint="Models vocal-tract length. Above 1.0 sounds like a shorter tract. This is what stops the chipmunk effect."
            />
            <AdvancedSlider
              id="voice-brightness"
              label="Brightness"
              unit="dB"
              value={overrides.brightnessDb ?? effective.brightnessDb}
              displayValue={effective.brightnessDb}
              min={-8}
              max={8}
              step={0.5}
              disabled={!enabled}
              onChange={(value) => setOverrides({ brightnessDb: value })}
              hint="High-shelf lift at 4.5 kHz — air and presence."
            />
            <AdvancedSlider
              id="voice-resonance"
              label="Resonance"
              unit="dB"
              value={overrides.resonanceDb ?? effective.resonanceDb}
              displayValue={effective.resonanceDb}
              min={-6}
              max={8}
              step={0.5}
              disabled={!enabled}
              onChange={(value) => setOverrides({ resonanceDb: value })}
              hint={`Peaking bell around ${Math.round(effective.resonanceHz)} Hz.`}
            />

            {hasOverrides ? (
              <Button variant="ghost" size="sm" onClick={resetOverrides} className="w-full">
                <RotateCcw aria-hidden /> Reset to preset
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Live engine readout — honest reporting, not decoration */}
      <section className="space-y-2 rounded-2xl bg-secondary/50 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Info className="size-3.5" aria-hidden />
          Engine
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <MetricRow
            icon={Timer}
            label="Added latency"
            value={
              metrics && metrics.active ? `${metrics.latencyMs.toFixed(1)} ms` : '—'
            }
          />
          <MetricRow
            icon={Cpu}
            label="CPU"
            value={
              metrics && metrics.active
                ? `${Math.round(metrics.cpuLoad * 100)}%`
                : '—'
            }
          />
          <MetricRow
            icon={Wand2}
            label="Frames"
            value={metrics && metrics.active ? metrics.framesProcessed.toLocaleString() : '—'}
          />
          <MetricRow
            icon={Info}
            label="Dropouts"
            value={metrics && metrics.active ? String(metrics.underruns) : '—'}
          />
        </dl>
        <p className="pt-1 text-[0.7rem] leading-relaxed text-muted-foreground">
          Real-time DSP running in your browser. Audio is processed on your device
          and never uploaded for conversion.
        </p>
      </section>
    </div>
  );
}

function MetricRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular ml-auto font-semibold">{value}</dd>
    </div>
  );
}

function AdvancedSlider({
  id,
  label,
  unit,
  value,
  displayValue,
  min,
  max,
  step,
  decimals = 1,
  disabled,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  unit: string;
  value: number;
  displayValue: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  hint: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span className="tabular text-xs font-semibold text-muted-foreground">
          {displayValue > 0 && unit === 'st' ? '+' : ''}
          {displayValue.toFixed(decimals)}
          {unit === 'x' ? '' : ' '}
          {unit}
        </span>
      </div>
      <Slider
        id={id}
        value={[value]}
        onValueChange={([next]) => onChange(next ?? 0)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
      />
      <p className="text-[0.7rem] leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}
