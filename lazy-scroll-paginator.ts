
interface LazyLoaderOptions {
  /** Offset from the edge of a container to load more items. */
  readonly loadMoreOffset: number;
  /** Initial page to load. */
  readonly initialPage: number;
}

/** Pagination model. */
export interface Pagination<T> {
  /** Number of elements. */
  itemsCount: number;

  /** Number of pages. */
  pagesCount?: number;

  /** Current page. */
  page?: number;

  /** Result. */
  items: T[];
}


class TwoSideLazyLoader<T, D = never> {
  /** Shows whether there are more items before. */
  public readonly haveMorePrevious$: Observable<boolean>;
  /** Shows if there are items after the initial page. */
  public readonly haveMoreNext$: Observable<boolean>;
  /** Lazy loaded items. */
  public readonly items$: Observable<T[]>;

  /** Emits number of page that is requested. */
  private readonly pageRequested$: Observable<number>;
  /** First page that should be loaded. */
  private readonly firstLoadedPage$ = new ReplaySubject<number>(1);
  /** Last loaded page of data. */
  private readonly lastLoadedData$ = new Subject<Pagination<T>>();
  /** Emitted when need to load data either from the start or end of list. */
  private readonly load$ = new Subject<'previous' | 'next'>();

  /** Subscription on container scroll events. */
  private containerScrollSubscription: Subscription;

  /**
   * @constructor
   * @param loadData Function loading the data for query and page.
   * @param query$ Query change emitter.
   * @param options Pagination options.
   */
  public constructor(
    loadData: (page: number, query: D) => Observable<Pagination<T>>,
    query$: Observable<D> = of(null),
    private readonly options: LazyLoaderOptions = {
      loadMoreOffset: 100,
      initialPage: 0,
    },
  ) {
    const queryChange$ = query$.pipe(
      tap(() => this.firstLoadedPage$.next(options.initialPage)),
      shareReplay({ refCount: true, bufferSize: 1 }),
    );

    this.haveMoreNext$ = queryChange$.pipe(
      switchMapTo(this.lastLoadedData$.pipe(
        map(({ page, pagesCount }) => pagesCount === 0 || page >= pagesCount - 1),
        first(endLoaded => endLoaded),
        mapTo(false), // Mark there is no more at bottom
        startWith(true),
      )),
      shareReplay({ refCount: true, bufferSize: 1 }),
    );

    this.haveMorePrevious$ = queryChange$.pipe(
      switchMapTo(this.lastLoadedData$.pipe(
        map(({ page }) => page === 0),
        first(endLoaded => endLoaded),
        mapTo(false), // Mark there is no more at top
        startWith(true),
      )),
      shareReplay({ refCount: true, bufferSize: 1 }),
    );

    const loadPrev$ = this.load$.pipe(
      filter(load => load === 'previous'), mapTo(null),
    );

    const loadNext$ = this.load$.pipe(
      filter(load => load === 'next'), mapTo(null),
    );

    const bottomPagesOffset$ = queryChange$.pipe(
      switchMapTo(paginate(loadNext$).pipe(skip(1))), // Skip initial pagination request
      withLatestFrom(this.haveMoreNext$),
      filter(([_, haveMore]) => haveMore),
      map(([offset]) => offset),
    );

    const topPagesOffset$ = queryChange$.pipe(
      switchMapTo(paginate(loadPrev$).pipe(skip(1))), // Skip initial pagination request
      withLatestFrom(this.haveMorePrevious$),
      filter(([_, haveMore]) => haveMore),
      map(([offset]) => -offset), // To have backward offset
    );

    const pageInit$ = this.firstLoadedPage$.pipe(filter(firstPageToLoad => firstPageToLoad != null));

    this.pageRequested$ = pageInit$.pipe(
      switchMapTo(combineLatest([
        merge(bottomPagesOffset$, topPagesOffset$),
        pageInit$,
      ])),
      map(([offset, firstPageToLoad]) => firstPageToLoad + offset),
      startWith(options.initialPage),
    );

    this.items$ = queryChange$.pipe(
      switchMapTo(this.pageRequested$.pipe(
        withLatestFrom(queryChange$),
        concatMap(([page, query]) => loadData(page, query).pipe(take(1))),
        withLatestFrom(this.firstLoadedPage$),
        scan((loadedItems: T[], [dataPage, firstLoadedPage]: [Pagination<T>, number]) => {
          this.lastLoadedData$.next(dataPage);
          if (firstLoadedPage == null || dataPage.page === firstLoadedPage) {
            // In case the initial page is not passed, take the first loaded
            this.firstLoadedPage$.next(dataPage.page);
            return dataPage.items;
          }
          if (dataPage.page < firstLoadedPage) {
            return dataPage.items.concat(loadedItems);
          }
          return loadedItems.concat(dataPage.items);
        }, [] as T[]),
        startWith(null),
      )),
    );
  }

  /**
   * Handle scrolling events on pagination container.
   * @param element Pagination container.
   */
  public attachTo(element: HTMLElement, scrollDebounceTime: number = 300): void {
    const handleScroll$ = merge(
      fromEvent(element, 'scroll'),
      this.items$,
    ).pipe(
      debounceTime(scrollDebounceTime),
      withLatestFrom(this.haveMorePrevious$, this.haveMoreNext$),
      tap(([_, morePrev, moreNext]) => {
        if (this.isElementScrolledToTop(element) && morePrev) {
          element.scrollTo({ top: this.options.loadMoreOffset });
          this.load$.next('previous');
        } else if (this.isElementScrolledToBottom(element) && moreNext) {
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

  private isElementScrolledToTop(elem: HTMLElement): boolean {
    return elem.scrollTop < this.options.loadMoreOffset;
  }

  private isElementScrolledToBottom(elem: HTMLElement): boolean {
    const topOffset = elem.offsetHeight + this.options.loadMoreOffset;
    return elem.scrollTop >= (elem.scrollHeight - topOffset);
  }
}

/**
 * Pagination helper.
 * @param nextPageRequested$ Hot observable that emits when page is requested.
 * @param pageReset$ Observable that emits when we want to reset pagination to 0.
 * @returns Page change observable.
 * @example
 *
 * const wantMore$ = new Subject<void>();
 * const queryChange$ = new Subject<void>();
 *
 * const paginationData$ = paginate(
 *    wantMore$,
 *    queryChange$,
 *  ).pipe(
 *    withLatestFrom(queryChange$),
 *    switchMap(([page, query]) =>
 *      someService.searchForSomething({ query, page })),
 *  );
 *
 * paginationData$.subscribe(console.log);
 *
 * queryChange$.next(); // prints data on 0 page
 * wantMore$.next(); // prints data on 1st page
 * queryChange.next(); // prints data on 0 page
 */
export function paginate(
  nextPageRequested$: Observable<void>,
  pageReset$: Observable<void> = of(null),
): Observable<number> {
  const pageAccumulation$ = nextPageRequested$.pipe(
    mapTo(1), // Set number of requested pages on every emit
    startWith(0), // Set initial page
    scan(((curPage: number, requestedPages: 1) => curPage + requestedPages)),
  );
  return pageReset$.pipe(
    switchMapTo(pageAccumulation$),
  );
}
