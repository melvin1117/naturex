/** Friendly aliases for generated schema types (from schema.d.ts; never hand-edit that). */
import type { components } from "./schema";

type Schemas = components["schemas"];

export type AlertOut = Schemas["AlertOut"];
export type AlertList = Schemas["AlertListOut"];
export type AlertsMarked = Schemas["AlertsMarkedOut"];
export type AssetCard = Schemas["AssetCard"];
export type AssetCreate = Schemas["AssetCreate"];
export type AssetDetail = Schemas["AssetDetail"];
export type AssetOutlines = Schemas["AssetOutlines"];
export type AssetSubmitted = Schemas["AssetSubmitted"];
export type AssetUpdate = Schemas["AssetUpdate"];
export type CommunityRole = Schemas["CommunityRole"];
export type CopilotRequest = Schemas["CopilotRequest"];
export type CopilotSource = Schemas["CopilotSource"];
/** One `data:` item of the `POST /copilot` SSE stream (T39). */
export type CopilotStreamEvent =
  | Schemas["CopilotSourcesEvent"]
  | Schemas["CopilotDeltaEvent"]
  | Schemas["CopilotDoneEvent"]
  | Schemas["CopilotErrorEvent"];
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
export type MetricChange = Schemas["MetricChange"];
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
export type RunTrace = Schemas["RunTraceOut"];
export type RunTraceStep = Schemas["RunTraceStep"];
export type TraceCall = Schemas["TraceCall"];
export type WorldTrace = Schemas["TraceOut"];
export type ReportDiff = Schemas["ReportDiff"];
export type ReportOut = Schemas["ReportOut"];
export type SiteImages = Schemas["SiteImages"];
export type StreamEvent = Schemas["StreamEvent"];
export type StreamEventType = Schemas["StreamEventType"];
export type WorldAsset = Schemas["WorldAssetOut"];
export type WorldOut = Schemas["WorldOut"];

// Listing verification (T69 API, T70 screens; ADR-0006).
export type AiComparison = Schemas["AiComparisonOut"];
export type AiDocumentReading = Schemas["AiDocumentReadingOut"];
export type AiExtractedField = Schemas["AiExtractedField"];
export type AiSuggestion = Schemas["AiSuggestionOut"];
export type AiSuggestionStatus =
  Schemas["ReviewQueueItem"]["ai_suggestion_status"];
export type CheckResult = Schemas["VerificationCheckOut"]["result"];
export type DocumentAiCheck = Schemas["WorldOut"]["document_ai_check"];
export type DocumentType = Schemas["DocumentType"];
export type ListingDocument = Schemas["ListingDocumentOut"];
export type PublicCheck = Schemas["PublicCheckOut"];
export type ReviewerRole = Schemas["ReviewerRole"];
export type ReviewQueueItem = Schemas["ReviewQueueItem"];
export type VerificationCheck = Schemas["VerificationCheckOut"];
export type VerificationLevel = Schemas["VerificationLevel"];
export type VerificationPublic = Schemas["VerificationPublicOut"];
export type VerificationRun = Schemas["VerificationRunOut"];

// Field evidence (T40): geotagged photos, their checks and the public aggregate.
export type FieldEvidence = Schemas["FieldEvidenceOut"];
export type FieldEvidencePublic = Schemas["FieldEvidencePublicOut"];
export type FieldPhoto = Schemas["FieldPhotoOut"];
export type FieldPhotoObservation = Schemas["FieldPhotoObservationOut"];

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
