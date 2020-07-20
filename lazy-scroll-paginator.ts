import {
  Observable,
  ReplaySubject,
  Subject,
  Subscription,
  of,
  combineLatest,
  merge,
  fromEvent,
  EMPTY,
  concat,
  forkJoin,
  BehaviorSubject,
  iif,
  observable,
} from 'rxjs';
import {
  map,
  tap,
  shareReplay,
  switchMapTo,
  first,
  mapTo,
  startWith,
  filter,
  skip,
  withLatestFrom,
  concatMap,
  take,
  scan,
  debounceTime,
  defaultIfEmpty,
  switchMap,
  pluck,
} from 'rxjs/operators';

function filterNull<T>() {
  return (observable: Observable<T | null>) =>
    observable.pipe(
      filter((data) => data != null),
      map((data) => data as NonNullable<T>),
    );
}

type PaginationDirection = 'next' | 'prev';
// PROBLY I FCKD UP THE WHOLE THING NOT USING NUM OF PAGE
/** Pagination model. */
export type Pagination<T = unknown> = {
  pos: PaginationDirection;
  /** Items. */
  items: T[];
  [K in PaginationDirection]: boolean;
};

type LoadDataFunction<Q, D> = (
  page: number,
  query: Q,
) => Observable<Pagination<D>>;

export class TwoSideLazyLoader<T, D = void> {
  /** Shows whether there are more items before. */
  public readonly haveMorePrevious$: Observable<boolean>;
  /** Shows if there are items after the initial page. */
  public readonly haveMoreNext$: Observable<boolean>;
  /** Lazy loaded items. */
  public readonly items$: Observable<Pagination<T>[] | null>;

  /** Next that should be loaded. */
  private readonly initialPage$: BehaviorSubject<number>;
  /** Page of data. */
  private readonly lastLoadedPage$: ReplaySubject<Pagination<T>>;
  /** Emitted when need to load data either from the start or end of list. */
  private readonly load$: Subject<PaginationDirection>;

  /** Subscription on container scroll events. */
  private containerScrollSubscription!: Subscription;

  /**
   * @constructor
   * @param loadData Function loading the data for query and page.
   * @param query$ Query change emitter.
   * @param options Pagination options.
   */
  public constructor(
    loadData: LoadDataFunction<D, Pagination<T>>,
    initialPage: number,
    query$: Observable<D> = EMPTY,
  ) {
    this.initialPage$ = new BehaviorSubject(initialPage);
    this.lastLoadedPage$ = new ReplaySubject(1);
    this.load$ = new Subject();

    const queryChange$ = query$.pipe(
      defaultIfEmpty(),
      shareReplay({ refCount: true, bufferSize: 1 }),
    );

    this.haveMoreNext$ = this.initMoreItemsStream(queryChange$, 'next');
    this.haveMorePrevious$ = this.initMoreItemsStream(queryChange$, 'prev');

    const pageRequested$ = this.initRequestedPageStream(queryChange$);
    this.items$ = this.initDataAccumulationStream(
      queryChange$,
      pageRequested$,
      loadData,
    );
  }

  private initMoreItemsStream(
    queryChange$: Observable<D>,
    direction: PaginationDirection,
  ): Observable<boolean> {
    return queryChange$.pipe(
      switchMapTo(
        this.lastLoadedPage$.pipe(
          pluck(direction),
          first((hasMore) => !hasMore),
          mapTo(false), // Mark there is no more at top
          startWith(true),
        ),
      ),
      shareReplay({ refCount: true, bufferSize: 1 }),
    );
  }

  private initRequestedPageStream(
    queryChange$: Observable<D>,
  ): Observable<number> {
    const loadPrev$: Observable<void> = this.load$.pipe(
      filter((load) => load === 'next'),
      mapTo(void 0),
    );

    const loadNext$: Observable<void> = this.load$.pipe(
      filter((load) => load === 'prev'),
      mapTo(void 0),
    );

    const bottomPagesOffset$ = queryChange$.pipe(
      switchMapTo(paginate(loadNext$)),
      withLatestFrom(this.haveMoreNext$),
      filter(([_, haveMore]) => haveMore),
      map(([offset]) => offset),
    );

    const topPagesOffset$ = queryChange$.pipe(
      switchMapTo(paginate(loadPrev$)),
      withLatestFrom(this.haveMorePrevious$),
      filter(([_, haveMore]) => haveMore),
      map(([offset]) => -offset), // To have backward offset *(-1)
    );

    return combineLatest([
      merge(bottomPagesOffset$, topPagesOffset$),
      this.initialPage$.pipe(filterNull()),
    ]).pipe(
      map(([offset, firstPageToLoad]) => firstPageToLoad + offset),
      startWith(this.initialPage$.value),
    );
  }

  private initDataAccumulationStream(
    queryChange$: Observable<D>,
    pageChange$: Observable<number>,
    loadData: LoadDataFunction<D, Pagination<T>>,
  ): Observable<Pagination<T>[] | null> {
    const lastLoaded$ = this.lastLoadedPage$.pipe(startWith(null));
    const accumulateData$ = pageChange$.pipe(
      withLatestFrom(queryChange$),
      concatMap(([page, query]) => loadData(page, query).pipe(take(1))),
      withLatestFrom(lastLoaded$),
      // Cache loaded data
      // tap(([nextPage]) => {
      //   this.lastLoadedPage$.next(nextPage);
      //   if (this.initialPage$.value == null) {
      //     // In case the initial page is not passed, take the first loaded
      //     this.initialPage$.next(nextPage.page);
      //   }
      // }),
      scan(
        (
          loadedItems: Pagination<T>[],
          [nextPage, prevPage]: [Pagination<T>, Pagination<T> | null],
        ) => {
          if (this.initialPage$.value === nextPage.page) {
            return nextPage.items;
          }
          if (nextPage.page < prevPage.page) {
            return nextPage.items.concat(loadedItems);
          }
          return loadedItems.concat(nextPage);
        },
        [] as T[],
      ),
      startWith(null),
    );

    return queryChange$.pipe(switchMapTo(accumulateData$));
  }

  /**
   * Handle scrolling events on pagination container.
   * @param element Pagination container.
   */
  public attachTo(
    element: HTMLElement,
    scrollDebounceTime: number = 300,
    loaderOffsetPx: number = 100,
  ): void {
    const handleScroll$ = merge(fromEvent(element, 'scroll'), this.items$).pipe(
      tap((data) => console.log(data)),
      debounceTime(scrollDebounceTime),
      withLatestFrom(this.haveMorePrevious$, this.haveMoreNext$),
      tap(([_, morePrev, moreNext]) => {
        if (this.isElementScrolledToTop(element, loaderOffsetPx) && morePrev) {
          element.scrollTo({ top: loaderOffsetPx });
          this.load$.next('prev');
        } else if (
          this.isElementScrolledToBottom(element, loaderOffsetPx) &&
          moreNext
        ) {
          this.load$.next('next');
        }
      }),
    );
    this.containerScrollSubscription = handleScroll$.subscribe();
  }

  /** Detach lazy loading controller from a container. */
  public detach(): void {
    this.containerScrollSubscription.unsubscribe();
  }

  private isElementScrolledToTop(elem: HTMLElement, offset: number): boolean {
    return elem.scrollTop < offset;
  }

  private isElementScrolledToBottom(
    elem: HTMLElement,
    offset: number,
  ): boolean {
    const topOffset = elem.offsetHeight + offset;
    return elem.scrollTop >= elem.scrollHeight - topOffset;
  }
}

/**
 * Pagination helper.
 * TODO
 */
export function paginate(
  this: void,
  nextPageRequested$: Observable<void>,
  pageReset$?: Observable<void>,
  startWith$?: Observable<number>,
): Observable<number> {
  const pageAccumulation$ = concat(
    startWith$ ? startWith$ : EMPTY,
    nextPageRequested$.pipe(
      mapTo(1), // Set number of requested pages on every emit
      scan(
        (curPage: number, requestedPages: number) => curPage + requestedPages,
      ),
    ),
  );

  return pageReset$
    ? pageReset$.pipe(switchMapTo(pageAccumulation$))
    : pageAccumulation$;
}
