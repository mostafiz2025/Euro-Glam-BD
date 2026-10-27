export default function Home() {
  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-6 py-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">
          Euro Glam BD
        </h1>
        <p className="max-w-prose text-neutral-600">
          Authentic European skincare, makeup and baby care — with an AI skin
          advisor, ingredient conflict checking, and climate-adapted guidance
          for Bangladesh.
        </p>

        <div className="mt-4 grid w-full gap-4 sm:grid-cols-3">
          {[
            {
              title: "AI Advisor",
              body: "Upload a photo and get product suggestions matched to your skin.",
            },
            {
              title: "Conflict Checker",
              body: "Deterministic ingredient rules catch unsafe combinations before checkout.",
            },
            {
              title: "Climate Tips",
              body: "Guidance on using cold-climate European formulas in a hot, humid climate.",
            },
          ].map((card) => (
            <div
              key={card.title}
              className="rounded-xl border border-neutral-200 bg-white p-5 text-left shadow-sm"
            >
              <h2 className="font-medium">{card.title}</h2>
              <p className="mt-2 text-sm text-neutral-600">{card.body}</p>
            </div>
          ))}
        </div>

        <p className="text-xs text-neutral-400">
          This is an aesthetic/skincare suggestion, not a medical prescription
          from a doctor.
        </p>
      </div>
    </main>
  );
}
