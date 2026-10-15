declare module 'lunar-javascript' {
  export class Solar {
    static fromYmd(year: number, month: number, day: number): Solar
    getLunar(): Lunar
    getYear(): number
    getMonth(): number
    getDay(): number
  }

  export class Lunar {
    /** 闰月用负的月份，例如闰四月是 -4。不存在的日子会抛错。 */
    static fromYmd(year: number, month: number, day: number): Lunar
    getSolar(): Solar
    getYear(): number
    getMonth(): number
    getDay(): number
  }
}
