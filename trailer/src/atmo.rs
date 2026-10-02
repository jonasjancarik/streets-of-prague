//! "Silence / engine": the atmospheric trailer. One car gets faster from dawn to night in
//! bursts that keep getting shorter, cut against still places where nothing happens;
//! then the dark, and the camera pulls back from the car until every street lamp of the
//! city is in the picture.
//!
//! The timing, the car's speed, the engine's revs and the camera's height all come from
//! `atmo/` (`atmo_data.rs` is made from it), which the shots and the sound follow too.
use crate::atmo_data::*;
use crate::TrailerMedia;
use fframes::{
    AudioMap, AudioTimestamp::*, AudioTrack, Color, Duration, FFramesContext, Frame, Scene, Scenes, Svgr,
    SyncVideoFrameInput, Video,
};

const FPS: f32 = 30.0;
const PAPER: &str = "#f3ecdd";
const RED: &str = "#d8362d";
const AMBER: &str = "#ffc480";
const NIGHT: &str = "#090b10";
const TITLE: &str = "Bebas Neue";
const MONO: &str = "IBM Plex Mono";
const TEXT: &str = "DM Sans";
/// The city's middle on the map, where the pull back ends (m).
pub(crate) const CITY: (f32, f32) = (-42.0, 28.0);

pub(crate) fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}
/// 0 at `a`, 1 at `b`, eased at both ends.
pub(crate) fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let u = clamp01((x - a) / (b - a));
    u * u * (3.0 - 2.0 * u)
}
/// Out fast, settling slowly.
pub(crate) fn settle(u: f32) -> f32 {
    1.0 - (1.0 - clamp01(u)).powi(3)
}
/// 12345.6 as "12 346".
pub(crate) fn spaced(n: f32) -> String {
    let digits = format!("{}", n.round() as i64);
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push('\u{2009}');
        }
        out.push(c);
    }
    out
}

pub struct AtmoVideo<'a> {
    pub media: &'a TrailerMedia,
    whole: Whole,
}

impl<'a> AtmoVideo<'a> {
    pub fn new(media: &'a TrailerMedia) -> Self {
        Self { media, whole: Whole }
    }
}

impl std::fmt::Debug for AtmoVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AtmoVideo").finish()
    }
}

impl Video for AtmoVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = crate::WIDTH;
    const HEIGHT: usize = crate::HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        // One track, built by atmo/soundtrack.py.
        AudioMap::from([AudioTrack::new("atmo.wav", Second(0.)..Eof).fade_out(1.2)])
    }

    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(vec![&self.whole as &dyn Scene])
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={crate::WIDTH} height={crate::HEIGHT} viewBox="0 0 1920 1080">
                <rect width="1920" height="1080" fill={NIGHT} />
                {ctx.render_scenes(&frame)}
            </svg>
        )
    }
}

/// The whole trailer as one scene: which part a frame belongs to is looked up in SEGMENTS.
#[derive(Debug)]
struct Whole;

/// A frame of a clip that began at frame `start` of the trailer, filling the picture
/// (scaled by `zoom` about its middle).
fn clip<'a>(frame: &Frame, ctx: &FFramesContext<'a, '_>, file: &'static str, start: usize, zoom: f32, opacity: f32) -> Svgr<'a> {
    use fframes::FFramesSyncedVideoFrame;
    let picture = frame
        .get_synced_video_frame(ctx, file, &SyncVideoFrameInput { start_from: start as f32 / FPS, looping: false, editor_fallback_image: None })
        .map(|v| v.into_image());
    let place = format!("translate({} {}) scale({zoom})", 960.0 * (1.0 - zoom), 540.0 * (1.0 - zoom));
    match picture {
        Some(image) => fframes::svgr!(<image href={image.href()} x="0" y="0" width="1920" height="1080" transform={place} opacity={opacity} />),
        None => fframes::svgr!(<g></g>),
    }
}

/// The time and the name of a still place, small in the top left corner.
fn caption<'a>(i: f32, n: f32, time: &'static str, place: &'static str) -> Svgr<'a> {
    let show = smooth(0.0, 9.0, i) * (1.0 - smooth(n - 5.0, n - 1.0, i));
    let rule = 64.0 * settle(i / 14.0);
    fframes::svgr!(<g opacity={show} font-family={MONO} font-size="36" letter-spacing="6" fill={PAPER}>
        <rect x="96" y="92" width={rule.max(0.5)} height="3" fill={RED} />
        <text x="96" y="146">{time}</text>
        <text x="266" y="146" opacity="0.8">{place}</text>
    </g>)
}

/// What the car is doing, over the bars of a burst: its speed, the gear, and the revs
/// as a line along the lower bar that turns red towards the limiter.
fn dials<'a>(e: usize, bars: f32) -> Svgr<'a> {
    let e = e.min(SPEED.len() - 1);
    let kmh = SPEED[e] * 3.6;
    let revs = REVS[e] / REDLINE;
    let hot = revs > 0.9;
    let y = 1080.0 - bars;
    fframes::svgr!(<g>
        <rect x="0" y={y - 3.0} width="1920" height="3" fill="#ffffff" opacity="0.12" />
        <rect x="0" y={y - 3.0} width={(1920.0 * revs).max(0.5)} height="3" fill={if hot { RED } else { PAPER }} />
        <text x="1824" y={y - 44.0} text-anchor="end" font-family={TITLE} font-size="210" letter-spacing="2" fill={PAPER}>{format!("{kmh:.0}")}</text>
        <text x="1824" y={y + 58.0} text-anchor="end" font-family={MONO} font-size="26" letter-spacing="6" fill={PAPER} opacity="0.75">"KM/H"</text>
        <text x="96" y={y + 58.0} font-family={MONO} font-size="26" letter-spacing="6" fill={if hot { RED } else { PAPER }} opacity="0.75">{format!("GEAR {}   {} RPM", GEARS[e], spaced((REVS[e] / 50.0).round() * 50.0))}</text>
    </g>)
}

/// A number counting up to `value` from second `at` of the pull back, with what it counts.
pub(crate) fn tally<'a>(seconds: f32, at: f32, row: f32, value: f32, label: &'static str) -> Svgr<'a> {
    let u = settle((seconds - at) / 1.6);
    let show = smooth(at, at + 0.4, seconds);
    let y = 392.0 + row * 132.0;
    fframes::svgr!(<g opacity={show} transform={format!("translate({} 0)", (1.0 - settle((seconds - at) / 0.7)) * -30.0)}>
        <rect x="96" y={y - 78.0} width="4" height="92" fill={RED} />
        <text x="124" y={y} font-family={TITLE} font-size="104" letter-spacing="2" fill={PAPER}>{spaced(value * u)}</text>
        <text x="126" y={y + 34.0} font-family={MONO} font-size="22" letter-spacing="5" fill={AMBER} opacity="0.9">{label}</text>
    </g>)
}

/// The map pictures at the camera's height `h` (m) over the point `c`, each fading into
/// the next, wider one. `dim`: 0..1, how far they are turned down (under the title).
/// `near`: another closest picture than MAPS' (a pull back that starts elsewhere).
pub(crate) fn maps<'a>(ctx: &FFramesContext<'a, '_>, h: f32, c: (f32, f32), fade_in: f32, dim: f32, near: Option<(&'static str, f32, f32, f32, f32)>) -> Vec<Svgr<'a>> {
    // The game's camera sees 2 h tan(19°) of ground top to bottom.
    let scale = 1080.0 / (0.6887 * h);
    let shares = [
        fade_in * (1.0 - smooth(1300.0, 2000.0, h)),
        smooth(1300.0, 2000.0, h) * (1.0 - smooth(9000.0, 15000.0, h)),
        smooth(9000.0, 15000.0, h),
    ];
    let mut levels = MAPS;
    if let Some(n) = near { levels[0] = n; }
    levels.into_iter().zip(shares).filter(|(_, share)| *share > 0.003).filter_map(|((file, x0, y1, w, hgt), share)| {
        let image = ctx.get_image(file)?;
        Some(fframes::svgr!(<image href={image.href()} x={960.0 + (x0 - c.0) * scale} y={540.0 - (y1 - c.1) * scale}
            width={w * scale} height={hgt * scale} opacity={share * (1.0 - dim)} preserveAspectRatio="none" />))
    }).collect()
}

impl Scene for Whole {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(FRAMES as f32 / FPS)
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let f = frame.index.min(FRAMES - 1);
        let at = SEGMENTS.iter().rposition(|s| s.1 <= f).unwrap_or(0);
        let (kind, start, frames, file, engine, time, place) = SEGMENTS[at];
        let (i, n) = ((f - start) as f32, frames as f32);
        match kind {
            // Before dawn.
            0 => {
                let show = smooth(8.0, 30.0, i) * (1.0 - smooth(n - 14.0, n - 2.0, i));
                fframes::svgr!(<g opacity={show}>
                    <text x="960" y="548" text-anchor="middle" font-family={MONO} font-size="56" letter-spacing="20" fill={PAPER}>"PRAHA"</text>
                    <rect x={960.0 - 30.0 * settle(i / 30.0)} y="580" width={(60.0 * settle(i / 30.0)).max(0.5)} height="3" fill={RED} />
                    <text x="960" y="640" text-anchor="middle" font-family={MONO} font-size="30" letter-spacing="10" fill={PAPER} opacity="0.6">"05:39"</text>
                </g>)
            }
            // A still place: the whole picture, drifting in a little, its time and name.
            1 => fframes::svgr!(<g>
                {clip(&frame, ctx, file, start, 1.0 + 0.02 * i / n, 1.0)}
                {caption(i, n, time, place)}
            </g>),
            // The engine: bars close in, the picture jolts, the dials run.
            2 | 3 => {
                let rush = kind == 3;
                let jolt = 1.0 + 0.07 * (1.0 - settle(i / 6.0)) + if rush { 0.03 } else { 0.0 };
                let bars = if rush { 118.0 } else { 118.0 * settle(i / 4.0) };
                let flash = 0.55 * (1.0 - clamp01(i / 3.0));
                fframes::svgr!(<g>
                    {clip(&frame, ctx, file, start, jolt, 1.0)}
                    <rect width="1920" height="1080" fill="#ffffff" opacity={flash} />
                    <rect x="0" y="0" width="1920" height={bars.max(0.5)} fill="#000000" />
                    <rect x="0" y={1080.0 - bars} width="1920" height={bars.max(0.5)} fill="#000000" />
                    {dials(engine + (f - start), bars)}
                </g>)
            }
            // The dark: the last speed hangs there and goes.
            4 => {
                let top = SPEED[SPEED.len() - 1] * 3.6;
                fframes::svgr!(<g opacity={1.0 - smooth(4.0, 22.0, i)}>
                    <text x="1824" y="918" text-anchor="end" font-family={TITLE} font-size="210" letter-spacing="2" fill={PAPER}>{format!("{top:.0}")}</text>
                    <text x="1824" y="1020" text-anchor="end" font-family={MONO} font-size="26" letter-spacing="6" fill={PAPER} opacity="0.75">"KM/H"</text>
                </g>)
            }
            // The pull back, and the title over where it ends.
            _ => {
                let rise = SEGMENTS.iter().find(|s| s.0 == 5).copied().unwrap_or(SEGMENTS[0]);
                let r = f - rise.1;
                let seconds = r as f32 / FPS;
                let h = HEIGHT[r.min(HEIGHT.len() - 1)];
                // The middle slides from the car to the city's middle as the view widens.
                let slide = smooth(0.0, 1.0, (h / 2500.0).max(1.0).ln() / (30000.0f32 / 2500.0).ln());
                let c = (RISE_AT.0 + (CITY.0 - RISE_AT.0) * slide, RISE_AT.1 + (CITY.1 - RISE_AT.1) * slide);
                let titled = kind == 6;
                let t = if titled { i } else { -1.0 };
                let dim = if titled { 0.55 * smooth(0.0, 24.0, t) } else { 0.0 };
                let film = if r < FILMED { clip(&frame, ctx, rise.3, rise.1, 1.0, smooth(0.0, 12.0, r as f32)) } else { fframes::svgr!(<g></g>) };
                let numbers = 1.0 - smooth(rise.2 as f32 - 20.0, rise.2 as f32 - 2.0, r as f32);
                fframes::svgr!(<g>
                    {film}
                    {maps(ctx, h, c, smooth(380.0, 820.0, h), dim, None)}
                    <g opacity={numbers}>
                        <text x="1824" y="146" text-anchor="end" font-family={MONO} font-size="26" letter-spacing="5" fill={PAPER} opacity={0.7 * smooth(0.4, 1.4, seconds)}>{format!("ALTITUDE {} M", spaced(if h < 1000.0 { h } else { (h / 100.0).round() * 100.0 }))}</text>
                        {tally(seconds, 4.3, 0.0, LAMPS, "STREET LAMPS")}
                        {tally(seconds, 5.2, 1.0, BUILDINGS, "BUILDINGS")}
                        {tally(seconds, 6.1, 2.0, ROAD_KM, "KM OF STREETS")}
                        {tally(seconds, 7.0, 3.0, KM2, "KM² OF MAP")}
                    </g>
                    <g opacity={if titled { smooth(4.0, 26.0, t) * (1.0 - smooth(n - 16.0, n - 2.0, t)) } else { 0.0 }}>
                        <text x="960" y={556.0 + 40.0 * (1.0 - settle(t / 30.0))} text-anchor="middle" font-family={TITLE} font-size="236" letter-spacing="10" fill={PAPER}>"STREETS OF PRAGUE"</text>
                        <rect x={960.0 - 270.0 * settle((t - 8.0) / 30.0)} y="604" width={(540.0 * settle((t - 8.0) / 30.0)).max(0.5)} height="7" fill={RED} />
                        <text x="960" y="690" text-anchor="middle" font-family={TEXT} font-size="42" letter-spacing="3" fill={PAPER} opacity={smooth(22.0, 44.0, t)}>"The whole city is the map."</text>
                        <text x="960" y="770" text-anchor="middle" font-family={TITLE} font-size="70" letter-spacing="6" fill={AMBER} opacity={smooth(34.0, 56.0, t)}>"STREETSOFPRAGUE.COM"</text>
                    </g>
                </g>)
            }
        }
    }
}
