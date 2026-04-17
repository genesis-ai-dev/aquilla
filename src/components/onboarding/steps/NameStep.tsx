export function NameStep({ value: _value, onChange: _onChange, onNext, onBack }: { value: string; onChange: (v: string) => void; onNext: () => void; onBack: () => void }) {
  return (
    <div>
      <button onClick={onBack}>Back</button>
      <button onClick={onNext}>Next (placeholder)</button>
    </div>
  )
}
