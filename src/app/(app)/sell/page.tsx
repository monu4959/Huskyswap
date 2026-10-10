"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Camera, ChevronDown, Plus, X } from "lucide-react";
import { Button, Field, Seg, Switch, TopBar, inputClass, useAction, useToast } from "@/components/ui";
import { CATEGORIES, CATEGORY_LABEL, CONDITION_LABEL, RENTAL_DAYS } from "@/lib/constants";
import { resizeImage } from "@/lib/format";
import { MEETUP_SPOTS } from "@/lib/reference";
import { useStore } from "@/lib/store";
import type { ItemCategory, ItemCondition } from "@/lib/types";

const MAX_PHOTOS = 6;
const CONDITIONS = Object.keys(CONDITION_LABEL) as ItemCondition[];

type Errors = Partial<Record<"title" | "category" | "condition" | "offer" | "price" | "weekly" | "deposit" | "spot", string>>;

const money = (v: string) => (v.trim() === "" ? NaN : Number(v));
const validMoney = (n: number) => Number.isFinite(n) && n >= 0 && n < 1_000_000;

export default function SellPage() {
  const router = useRouter();
  const { createListing } = useStore();
  const act = useAction();
  const toast = useToast();

  const [images, setImages] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<ItemCategory | "">("");
  const [condition, setCondition] = useState<ItemCondition | "">("");
  const [forSale, setForSale] = useState(true);
  const [forRent, setForRent] = useState(false);
  const [price, setPrice] = useState("");
  const [weekly, setWeekly] = useState("");
  const [deposit, setDeposit] = useState("");
  const [spot, setSpot] = useState("");
  const [errors, setErrors] = useState<Errors>({});

  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    try {
      const resized = await Promise.all([...files].slice(0, MAX_PHOTOS - images.length).map((f) => resizeImage(f)));
      setImages((prev) => [...prev, ...resized]);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    if (title.trim().length < 3) next.title = "Give it a title of at least 3 characters.";
    if (!category) next.category = "Pick a category.";
    if (!condition) next.condition = "Pick a condition.";
    if (!forSale && !forRent) next.offer = "Turn on Sell, Rent, or both.";
    if (forSale && !validMoney(money(price))) next.price = "Enter a price (0 for free).";
    if (forRent && !validMoney(money(weekly))) next.weekly = "Enter a price for the week.";
    if (forRent && deposit.trim() && !validMoney(money(deposit))) next.deposit = "Enter a deposit or leave it empty.";
    if (!spot) next.spot = "Pick where you'll meet.";
    setErrors(next);
    if (Object.keys(next).length) {
      document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
      return;
    }
    const id = await act(
      () =>
        createListing({
          title,
          description,
          category: category as ItemCategory,
          condition: condition as ItemCondition,
          meetup_spot_id: Number(spot),
          sale: forSale ? { price: money(price) } : null,
          rental: forRent ? { price_per_week: money(weekly), deposit: deposit.trim() ? money(deposit) : 0 } : null,
          images,
        }),
      "Listing posted",
    );
    if (id) router.replace(`/item/${id}`);
  };

  return (
    <>
      <TopBar back="/" backIcon="close" title="New listing" />
      <form onSubmit={submit} noValidate className="space-y-3.5 px-5 pt-1 pb-32">
        <fieldset>
          <legend className="sr-only">Photos</legend>
          <div className="grid grid-cols-3 gap-2.5">
            {images.map((src, i) => (
              <div key={i} className="relative h-[82px] overflow-hidden rounded-2xl shadow-raise">
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
                <img src={src} alt={`Photo ${i + 1}${i === 0 ? ", cover" : ""}`} className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove photo ${i + 1}`}
                  className="absolute top-0 right-0 grid size-9 cursor-pointer place-items-center"
                >
                  <span className="grid size-6 place-items-center rounded-full bg-black/65 text-white">
                    <X className="size-3.5" />
                  </span>
                </button>
                {i === 0 && <span className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[11px] font-semibold text-white">Cover</span>}
              </div>
            ))}
            {images.length < MAX_PHOTOS && (
              <label className="grid h-[82px] cursor-pointer place-content-center justify-items-center gap-0.5 rounded-2xl border-[1.5px] border-dashed border-muted/55 text-center text-[11.5px] text-muted hover:text-fg">
                {images.length ? <Plus className="size-[22px]" aria-hidden /> : <Camera className="size-[22px]" aria-hidden />}
                {images.length ? "More" : "Add photo"}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    addPhotos(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
        </fieldset>

        <Field label="Title" error={errors.title}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="Desk lamp, warm light" className={inputClass} aria-invalid={!!errors.title} />
        </Field>

        <Field label="Details" hint="Edition, size, flaws, what's included.">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} className={`${inputClass} resize-none`} />
        </Field>

        <Field label="Category" error={errors.category}>
          <Select value={category} onChange={(v) => setCategory(v as ItemCategory)} invalid={!!errors.category}>
            <option value="" disabled>
              Choose one
            </option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <span className="mb-[7px] block text-[12.5px] font-semibold text-muted">Condition</span>
          <div aria-invalid={!!errors.condition}>
            <Seg<ItemCondition | "">
              label="Condition"
              value={condition}
              onChange={setCondition}
              options={CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABEL[c] }))}
            />
          </div>
          {errors.condition && <p className="mt-1.5 text-[12.5px] text-coral">{errors.condition}</p>}
        </div>

        <div>
          <span className="mb-[7px] block text-[12.5px] font-semibold text-muted">Offer it for</span>
          <div className="rounded-[18px] bg-surface px-3.5 py-1 shadow-raise">
            <OfferRow label="Sell" checked={forSale} onChange={setForSale}>
              <MoneyInput label="Sale price" value={price} onChange={setPrice} invalid={!!errors.price} />
            </OfferRow>
            <OfferRow label="Rent" sub={`for ${RENTAL_DAYS} days`} checked={forRent} onChange={setForRent} border>
              <MoneyInput label="Price for the week" value={weekly} onChange={setWeekly} invalid={!!errors.weekly} />
            </OfferRow>
            {forRent && (
              <div className="flex h-[46px] items-center gap-2.5 border-t border-line">
                <b className="flex-1 text-[14px] font-semibold">
                  Deposit <span className="font-normal text-muted">(optional)</span>
                </b>
                <MoneyInput label="Deposit" value={deposit} onChange={setDeposit} invalid={!!errors.deposit} />
                <span className="w-10" />
              </div>
            )}
          </div>
          {(errors.offer || errors.price || errors.weekly || errors.deposit) && (
            <p className="mt-1.5 text-[12.5px] text-coral">{errors.offer ?? errors.price ?? errors.weekly ?? errors.deposit}</p>
          )}
        </div>

        <Field label="Meetup spot" error={errors.spot} hint="Boston-area spots only for now.">
          <Select value={spot} onChange={setSpot} invalid={!!errors.spot}>
            <option value="" disabled>
              Choose a spot
            </option>
            {MEETUP_SPOTS.map((s) => (
              <option key={s.spot_id} value={s.spot_id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[480px] bg-bg/95 px-5 pt-3 pb-[max(env(safe-area-inset-bottom),22px)] backdrop-blur-sm">
          <Button type="submit" className="w-full">
            Post listing
          </Button>
        </div>
      </form>
    </>
  );
}

function OfferRow({
  label,
  sub,
  checked,
  onChange,
  border,
  children,
}: {
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  border?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex h-[46px] items-center gap-2.5 ${border ? "border-t border-line" : ""}`}>
      <b className="flex-1 text-[14px] font-semibold">
        {label} {sub && <span className="font-normal text-muted">{sub}</span>}
      </b>
      {checked ? children : <span className="text-[12.5px] text-muted">Off</span>}
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function MoneyInput({ label, value, onChange, invalid }: { label: string; value: string; onChange: (v: string) => void; invalid: boolean }) {
  return (
    <label className="font-display flex h-8 w-[84px] items-center rounded-[10px] bg-field px-2 text-[14px] font-semibold shadow-inset focus-within:ring-[1.5px] focus-within:ring-cyan">
      <span aria-hidden className="text-muted">
        $
      </span>
      <span className="sr-only">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        aria-invalid={invalid}
        className="w-full min-w-0 bg-transparent pl-1 text-fg outline-none placeholder:text-muted"
      />
    </label>
  );
}

function Select({ value, onChange, invalid, children }: { value: string; onChange: (v: string) => void; invalid: boolean; children: ReactNode }) {
  return (
    <span className="relative block">
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} className={`${inputClass} cursor-pointer appearance-none pr-10`}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
    </span>
  );
}
