/** Friendly aliases for generated schema types (from schema.d.ts; never hand-edit that). */
import type { components } from "./schema";

type Schemas = components["schemas"];

export type AssetCard = Schemas["AssetCard"];
export type AssetCreate = Schemas["AssetCreate"];
export type AssetDetail = Schemas["AssetDetail"];
export type AssetOutlines = Schemas["AssetOutlines"];
export type AssetSubmitted = Schemas["AssetSubmitted"];
export type AssetUpdate = Schemas["AssetUpdate"];
export type CommunityRole = Schemas["CommunityRole"];
export type EventOut = Schemas["EventOut"];
export type HoldingOut = Schemas["HoldingOut"];
export type IpoLaunch = Schemas["IpoLaunch"];
export type IpoOut = Schemas["IpoOut"];
export type IpoPreview = Schemas["IpoPreviewOut"];
export type LedgerEntry = Schemas["LedgerEntryOut"];
export type LegendEntry = Schemas["LegendEntry"];
export type LedgerVerify = Schemas["LedgerVerifyOut"];
export type LoginIn = Schemas["LoginIn"];
export type MeOut = Schemas["MeOut"];
export type MyCommunity = Schemas["MyCommunityOut"];
export type OrderCreate = Schemas["OrderCreate"];
export type OrderOut = Schemas["OrderOut"];
export type Persona = Schemas["PersonaOut"];
export type PortfolioOut = Schemas["PortfolioOut"];
export type PricePoint = Schemas["PricePoint"];
export type QuoteOut = Schemas["QuoteOut"];
export type RatingRun = Schemas["RatingRunOut"];
export type RatingRunStep = Schemas["RatingRunStep"];
export type RegisterIn = Schemas["RegisterIn"];
export type ReportDiff = Schemas["ReportDiff"];
export type ReportOut = Schemas["ReportOut"];
export type SiteImages = Schemas["SiteImages"];
export type StreamEvent = Schemas["StreamEvent"];
export type StreamEventType = Schemas["StreamEventType"];
export type WorldAsset = Schemas["WorldAssetOut"];
export type WorldOut = Schemas["WorldOut"];

// Steward home and community management (T63).
export type CommunityOut = Schemas["CommunityOut"];
export type CommunityCreate = Schemas["CommunityCreate"];
export type CommunityUpdate = Schemas["CommunityUpdate"];
export type CommunityMember = Schemas["CommunityMemberOut"];
export type CommunitySummary = Schemas["CommunitySummaryOut"];
export type ListingSummary = Schemas["ListingSummaryOut"];
export type NextAction = Schemas["NextAction"];
export type PayoutSummary = Schemas["PayoutSummaryOut"];
export type Wallet = Schemas["WalletOut"];
