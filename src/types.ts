// Shapes returned by NJ Transit's RailData API. Field names are NJ Transit's own
// (all values are strings unless noted). We keep the raw data as-is and only
// format it for display, per NJ Transit's developer terms.

export interface Station {
  STATION_2CHAR: string;
  STATIONNAME: string;
  STATION_14CHAR?: string;
}

export interface StopLine {
  LINE_CODE?: string;
  LINE_NAME?: string;
  LINE_COLOR?: string;
}

export interface Stop {
  STATION_2CHAR: string;
  STATIONNAME: string;
  TIME?: string;
  PICKUP?: string;
  DROPOFF?: string;
  DEPARTED?: string; // "YES" / "NO"
  STOP_STATUS?: string; // e.g. "OnTime", "Late", "Cancelled"
  DEP_TIME?: string;
  TIME_UTC_FORMAT?: string;
  STOP_LINES?: StopLine[];
}

/** One car of a train (field names from the raildata client; not yet checked against a live answer). */
export interface CapacityCar {
  CAR_NO?: string;
  /** 1 is the front of the train. */
  CAR_POSITION?: string | number;
  /** Whether the car has a restroom ("Y"/"N" or true/false). */
  CAR_REST?: string | boolean;
  CUR_PERCENTAGE?: string | number;
  CUR_CAPACITY_COLOR?: string;
  CUR_PASSENGER_COUNT?: string | number;
}

/** Front, middle or back of a train, with its cars. */
export interface CapacitySection {
  /** 0/1/2 or "Front"/"Middle"/"Back". */
  SECTION_POSITION?: string | number;
  CUR_PERCENTAGE?: string | number;
  CUR_CAPACITY_COLOR?: string;
  CUR_PASSENGER_COUNT?: string | number;
  CARS?: CapacityCar[];
}

export interface Capacity {
  VEHICLE_NO?: string;
  CREATED_TIME?: string;
  VEHICLE_TYPE?: string;
  CUR_PERCENTAGE?: string;
  CUR_CAPACITY_COLOR?: string;
  CUR_PASSENGER_COUNT?: string;
  SECTIONS?: CapacitySection[];
}

export interface ScheduleItem {
  SCHED_DEP_DATE: string;
  DESTINATION: string;
  TRACK?: string;
  LINE?: string;
  TRAIN_ID: string;
  CONNECTING_TRAIN_ID?: string;
  STATUS?: string;
  SEC_LATE?: string;
  LAST_MODIFIED?: string;
  GPSLATITUDE?: string;
  GPSLONGITUDE?: string;
  GPSTIME?: string;
  STATION_POSITION?: string;
  LINECODE?: string;
  LINEABBREVIATION?: string;
  INLINEMSG?: string;
  /** "Eastbound" (toward New York or Hoboken) or "Westbound", when NJ Transit sends it. */
  DIRECTION?: string;
  CAPACITY?: Capacity[];
  STOPS?: Stop[] | null;
}

export interface StationMessage {
  MSG_TYPE?: string;
  MSG_TEXT: string;
  MSG_PUBDATE?: string;
  MSG_ID?: string;
  MSG_AGENCY?: string;
  MSG_SOURCE?: string;
  MSG_STATION_SCOPE?: string;
  MSG_LINE_SCOPE?: string;
  MSG_PUBDATE_UTC?: string;
}

export interface StationBoard {
  STATION_2CHAR: string;
  STATIONNAME: string;
  STATIONMSGS?: StationMessage[];
  ITEMS: ScheduleItem[] | null;
}

export interface TrainStopList {
  TRAIN_ID: string;
  LINECODE?: string;
  DESTINATION?: string;
  TRANSFERAT?: string;
  STOPS: Stop[] | null;
  CAPACITY?: Capacity[];
}

/** Where the server gets its train data: NJ Transit live, or built-in sample data. */
export interface RailSource {
  readonly mode: "live" | "mock";
  stations(): Promise<Station[]>;
  /** Next ~19 departures from a station (getTrainSchedule19Rec). */
  departures(station: string): Promise<StationBoard>;
  /** Full departure board with each train's stops (getTrainSchedule). */
  boardWithStops(station: string): Promise<StationBoard>;
  /** Every stop of one train (getTrainStopList). */
  trainStops(trainId: string): Promise<TrainStopList>;
  /** Service alerts, optionally for one station (getStationMSG). */
  alerts(station?: string): Promise<StationMessage[]>;
}

/** A tiny key-value store, so a Cloudflare KV namespace or a Map can back the cache. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** Settings read from environment variables. */
export interface Config {
  njtUsername?: string;
  njtPassword?: string;
  njtToken?: string;
  useTestApi?: boolean;
  forceMock?: boolean;
  accessKey?: string;
  allowedOrigins?: string[];
  /** Commute stations for my_commute (names or codes, as typed). */
  commuteHome?: string;
  commuteAway?: string;
  kv?: KVLike;
}
