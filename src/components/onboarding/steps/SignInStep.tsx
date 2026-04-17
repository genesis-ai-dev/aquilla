export function SignInStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <div>
      <button onClick={onBack}>Back</button>
      <button onClick={onNext}>Next (placeholder)</button>
    </div>
  )
}
